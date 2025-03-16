package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sync"

	"github.com/gorilla/websocket"
	"tris.sh/project/client"
	"tris.sh/project/server/api"
	"tris.sh/project/server/database"
	"tris.sh/project/server/env"
	"tris.sh/project/server/websockets"
)

func requireLogin(handler func(http.ResponseWriter, *http.Request, *database.DB, int), db *database.DB) func(http.ResponseWriter, *http.Request) {
	validateLogin := func(w http.ResponseWriter, r *http.Request) {
		fmt.Println(r.URL.Path)
		c, err := r.Cookie("session_token")
		if err != nil {
			if err == http.ErrNoCookie {
				fmt.Println("Missing Session Token")
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			fmt.Println("Bad Request")
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		session_token := c.Value
		fmt.Println(session_token)
		var user_id int
		err = db.Read.QueryRow("SELECT user_id FROM sessions where token = $1 and created_at > DATETIME(CURRENT_TIMESTAMP, '-1440 minutes');", session_token).Scan(&user_id)
		if err != nil {
			fmt.Println("Unauthorized")
			fmt.Println(err)
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		fmt.Println(user_id)
		handler(w, r, db, user_id)
	}
	return validateLogin

}

func requireDB(handler func(http.ResponseWriter, *http.Request, *database.DB), db *database.DB) func(http.ResponseWriter, *http.Request) {
	return func(w http.ResponseWriter, r *http.Request) {
		handler(w, r, db)
	}
}


type TestMessage struct {
	Example string
}

type ClientMessage struct {
	ClientData string
}

var (
	clients = make(map[*websocket.Conn]bool)
	clientsMu sync.Mutex
)

func serveSpa(w http.ResponseWriter, r *http.Request) {
	buildPath := "dist"

	path, err := client.BuildFS.Open(filepath.Join(buildPath, r.URL.Path))
	fmt.Println(err)
	if os.IsNotExist(err) {
		index, err := client.BuildFS.ReadFile(filepath.Join(buildPath, "index.html"))
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		w.WriteHeader(http.StatusAccepted)
		w.Write(index)
		return
	} else if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	defer path.Close()

	http.FileServer(client.BuildHTTPFS()).ServeHTTP(w, r)
}

func main() {
	db, err := database.New(context.Background(), env.DATA_DIR + "/sqlite.db")
	if err != nil {
		log.Fatal(err)
	}
	database.Init(db)


	http.HandleFunc("/ws", requireLogin(websockets.HandleWebsocket, db))
	http.HandleFunc("/api/paste", requireLogin(api.Paste, db))
	http.HandleFunc("/api/get_clipboards", requireLogin(api.GetClipboards, db))
	http.HandleFunc("/api/login", requireDB(api.Login, db))

	http.HandleFunc("/", serveSpa)

	websockets.Init()

	fmt.Println("Starting server at port 8080")

	if err:= http.ListenAndServe(":8080", nil); err != nil {
		log.Fatal(err)
	}
}
