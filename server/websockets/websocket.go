package websockets

import (
	"fmt"
	"log"
	"net/http"
	"sync"

	"github.com/gorilla/websocket"
	"tris.sh/project/server/database"
)

type ClientsMutex struct {
	mu sync.Mutex
	clients map[*websocket.Conn]bool
}

type MutexMap struct {
	mu sync.Mutex
	mutexes map[int]*ClientsMutex
}

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool {
		return true // Allow all connections (adjust for production)
	},
}

func (m *MutexMap) GetUserClients(user_id int) *ClientsMutex {
	m.mu.Lock()
	defer m.mu.Unlock()

	if _, exists := m.mutexes[user_id]; !exists {
		m.mutexes[user_id] = &ClientsMutex{mu: sync.Mutex{}, clients: make(map[*websocket.Conn]bool)}
	}

	return m.mutexes[user_id]
}

var mutexMap *MutexMap

func Init() {
	mutexMap = &MutexMap{mu: sync.Mutex{}, mutexes: make(map[int]*ClientsMutex)}
}

func connect(conn *websocket.Conn, user_id int) {
	userMutex := mutexMap.GetUserClients(user_id)
	userMutex.mu.Lock()
	defer userMutex.mu.Unlock()
	userMutex.clients[conn] = true
	log.Println("New client connected")
}

func disconnect(conn *websocket.Conn, user_id int) {
	userMutex := mutexMap.GetUserClients(user_id)
	userMutex.mu.Lock()
	defer userMutex.mu.Unlock()
	delete(userMutex.clients, conn)
}

type UpdateType string
type ClipboardType string

const (
	Add UpdateType = "append"
	Remove UpdateType = "remove"
)

const (
	Text ClipboardType = "text/plain"
	PNG ClipboardType = "image/png"
)

type Clipboard struct {
	Id int64
	Content string
	Type ClipboardType
}

type ClipboardUpdate struct {
	Clipboard Clipboard
	Type UpdateType
}


func Broadcast(update ClipboardUpdate, user_id int) {
	userMutex := mutexMap.GetUserClients(user_id)
	userMutex.mu.Lock()
	defer userMutex.mu.Unlock()

	for client := range userMutex.clients {
		err := client.WriteJSON(update)
		if err != nil {
			log.Println("Broadcast failed:", err)
			client.Close()
			delete(userMutex.clients, client)
		}
	}
}

func HandleWebsocket(w http.ResponseWriter, r *http.Request, db *database.DB, user_id int) {
	fmt.Println("New websocket connection")
	// Upgrade HTTP to WebSocket
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Println("Upgrade failed:", err)
		return
	}
	defer conn.Close()

	connect(conn, user_id)

	// Listen for messages from the client
	for {
		_, _, err := conn.ReadMessage()
		fmt.Println(err)
		if err != nil {
			log.Println("Client disconnected:", err)
			break
		}
	}

	disconnect(conn, user_id)
}
