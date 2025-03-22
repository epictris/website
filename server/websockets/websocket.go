package websockets

import (
	"errors"
	"fmt"
	"log"
	"net/http"
	"sync"

	"github.com/gorilla/websocket"
)

type ClientsMutex struct {
	mu sync.Mutex
	clients map[string]*websocket.Conn
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
		m.mutexes[room_code] = &ClientsMutex{mu: sync.Mutex{}, clients: make(map[string]*websocket.Conn)}
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

func sendStatusUpdate(clients map[string]*websocket.Conn) {
	for session_token := range clients {
		client := clients[session_token]
		err := client.WriteJSON(StatusMessage{Type: "status", Clients: len(clients)})
		if err != nil {
			log.Println("Broadcast failed:", err)
			client.Close()
			delete(clients, session_token)
		}
	}
}

func connect(conn *websocket.Conn, room_code string, session_token string) error {
	userMutex := roomsMutexMap.GetRoomClients(room_code)
	userMutex.mu.Lock()
	defer userMutex.mu.Unlock()

	existing_conn, exists := userMutex.clients[session_token]
	if exists {
		fmt.Println("Client already connected")
		msg := websocket.FormatCloseMessage(websocket.CloseNormalClosure, "Client connected")
		existing_conn.WriteMessage(websocket.CloseMessage, msg)
		existing_conn.Close()
	} else if len(userMutex.clients) > 1 {
		fmt.Println("Room is full")
		msg := websocket.FormatCloseMessage(websocket.CloseNormalClosure, "Room is full")
		conn.WriteMessage(websocket.CloseMessage, msg)
		conn.Close()
		return errors.New("Room is full")
	}

	userMutex.clients[session_token] = conn
	sendStatusUpdate(userMutex.clients)
	log.Println("New client connected", session_token)
	return nil
}

func disconnect(conn *websocket.Conn, room_code string, session_token string) {
	userMutex := roomsMutexMap.GetRoomClients(room_code)
	userMutex.mu.Lock()
	defer userMutex.mu.Unlock()
	existing_conn, exists := userMutex.clients[session_token]
	if exists {
		if existing_conn == conn {
			delete(userMutex.clients, session_token)
		}
	}
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

	for session_token := range userMutex.clients {
		client := userMutex.clients[session_token]
		err := client.WriteMessage(messageType, data)
		if err != nil {
			log.Println("Broadcast failed:", err)
			client.Close()
			delete(userMutex.clients, session_token)
		}
	}
}

func HandleWebsocket(w http.ResponseWriter, r *http.Request) {
	room := r.FormValue("id")
	session_token := r.FormValue("session_token")

	fmt.Println(session_token, room)

	// Upgrade HTTP to WebSocket
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Println("Upgrade failed:", err)
		return
	}
	defer conn.Close()

	err = connect(conn, room, session_token)
	if err != nil {
		return
	}
	fmt.Println("New websocket connection to room", room)

	// Listen for messages from the client
	for {
		messageType, data, err := conn.ReadMessage()

		if err != nil {
			log.Println("Client disconnected:", err)
			msg := websocket.FormatCloseMessage(websocket.CloseNormalClosure, "Client connected")
			conn.WriteMessage(websocket.CloseMessage, msg)
			conn.Close()
			break
		}

		Broadcast(room, messageType, data)
	}

	disconnect(conn, room, session_token)
}
