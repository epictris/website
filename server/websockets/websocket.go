package websockets

import (
	"fmt"
	"log"
	"net/http"
	"sync"

	"github.com/gorilla/websocket"
)

type ClientsMutex struct {
	mu sync.Mutex
	clients map[*websocket.Conn]bool
}

type RoomsMutexMap struct {
	mu sync.Mutex
	mutexes map[string]*ClientsMutex
}

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool {
		return true // Allow all connections (adjust for production)
	},
}

func (m *RoomsMutexMap) GetRoomClients(room_code string) *ClientsMutex {
	m.mu.Lock()
	defer m.mu.Unlock()

	if _, exists := m.mutexes[room_code]; !exists {
		m.mutexes[room_code] = &ClientsMutex{mu: sync.Mutex{}, clients: make(map[*websocket.Conn]bool)}
	}

	return m.mutexes[room_code]
}

var roomsMutexMap *RoomsMutexMap

func Init() {
	roomsMutexMap = &RoomsMutexMap{mu: sync.Mutex{}, mutexes: make(map[string]*ClientsMutex)}
}

type StatusMessage struct {
	Type string
	Clients int
}

func sendStatusUpdate(clients map[*websocket.Conn]bool) {
	for client := range clients {
		err := client.WriteJSON(StatusMessage{Type: "status", Clients: len(clients)})
		if err != nil {
			log.Println("Broadcast failed:", err)
			client.Close()
			delete(clients, client)
		}
	}
}

func connect(conn *websocket.Conn, room_code string) {
	userMutex := roomsMutexMap.GetRoomClients(room_code)
	userMutex.mu.Lock()
	defer userMutex.mu.Unlock()
	userMutex.clients[conn] = true
	sendStatusUpdate(userMutex.clients)
	log.Println("New client connected")
}

func disconnect(conn *websocket.Conn, room_code string) {
	userMutex := roomsMutexMap.GetRoomClients(room_code)
	userMutex.mu.Lock()
	defer userMutex.mu.Unlock()
	delete(userMutex.clients, conn)
	sendStatusUpdate(userMutex.clients)
}

func getClientCount(room_code string) int {
	return len(roomsMutexMap.GetRoomClients(room_code).clients)
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

func Broadcast(room_code string, messageType int, data []byte) {
	userMutex := roomsMutexMap.GetRoomClients(room_code)
	userMutex.mu.Lock()
	defer userMutex.mu.Unlock()

	for client := range userMutex.clients {
		err := client.WriteMessage(messageType, data)
		if err != nil {
			log.Println("Broadcast failed:", err)
			client.Close()
			delete(userMutex.clients, client)
		}
	}
}

func HandleWebsocket(w http.ResponseWriter, r *http.Request) {
	room := r.FormValue("id")
	// Upgrade HTTP to WebSocket
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Println("Upgrade failed:", err)
		return
	}
	if getClientCount(room) > 1 {
		fmt.Println("Room is full")
		msg := websocket.FormatCloseMessage(websocket.CloseNormalClosure, "Room is full")
		conn.WriteMessage(websocket.CloseMessage, msg)
		conn.Close()
		return
	}
	fmt.Println("New websocket connection to room", room)
	defer conn.Close()

	connect(conn, room)

	// Listen for messages from the client
	for {
		messageType, data, err := conn.ReadMessage()

		if err != nil {
			log.Println("Client disconnected:", err)
			break
		}

		Broadcast(room, messageType, data)
	}

	disconnect(conn, room)
}
