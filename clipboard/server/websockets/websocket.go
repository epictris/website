package websockets

import (
	"log"
	"net/http"
	"sync"

	"github.com/gorilla/websocket"
)

type ClientsMutex struct {
	mu      sync.Mutex
	clients map[*websocket.Conn]bool
}

type RoomsMutexMap struct {
	mu      sync.Mutex
	mutexes map[string]*ClientsMutex
}

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool {
		return true
	},
}

func (m *RoomsMutexMap) GetRoomClients(room_code string) *ClientsMutex {
	m.mu.Lock()
	defer m.mu.Unlock()

	if _, exists := m.mutexes[room_code]; !exists {
		m.mutexes[room_code] = &ClientsMutex{
			mu:      sync.Mutex{},
			clients: make(map[*websocket.Conn]bool),
		}
	}

	return m.mutexes[room_code]
}

var roomsMutexMap *RoomsMutexMap

func Init() {
	roomsMutexMap = &RoomsMutexMap{mu: sync.Mutex{}, mutexes: make(map[string]*ClientsMutex)}
}

type StatusMessage struct {
	Type    string
	Clients int
}

func sendStatusUpdate(clients map[*websocket.Conn]bool) {
	for conn := range clients {
		err := conn.WriteJSON(StatusMessage{Type: "status", Clients: len(clients)})
		if err != nil {
			log.Println("Broadcast failed:", err)
			conn.Close()
			delete(clients, conn)
		}
	}
}

func connect(conn *websocket.Conn, room_code string) error {
	userMutex := roomsMutexMap.GetRoomClients(room_code)
	userMutex.mu.Lock()
	defer userMutex.mu.Unlock()

	userMutex.clients[conn] = true
	sendStatusUpdate(userMutex.clients)
	log.Println("New client connected to room", room_code)
	return nil
}

func disconnect(conn *websocket.Conn, room_code string) {
	userMutex := roomsMutexMap.GetRoomClients(room_code)
	userMutex.mu.Lock()
	defer userMutex.mu.Unlock()
	delete(userMutex.clients, conn)
	sendStatusUpdate(userMutex.clients)
}

func Broadcast(room_code string, messageType int, data []byte) {
	userMutex := roomsMutexMap.GetRoomClients(room_code)
	userMutex.mu.Lock()
	defer userMutex.mu.Unlock()

	for conn := range userMutex.clients {
		err := conn.WriteMessage(messageType, data)
		if err != nil {
			log.Println("Broadcast failed:", err)
			conn.Close()
			delete(userMutex.clients, conn)
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
	defer conn.Close()

	err = connect(conn, room)
	if err != nil {
		log.Println("Connection failed:", err)
		return
	}

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

	disconnect(conn, room)
}
