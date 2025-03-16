package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"tris.sh/project/client"
	"tris.sh/project/server/api"
	"tris.sh/project/server/database"
	"tris.sh/project/server/env"
	"tris.sh/project/server/logic/auth"
	"tris.sh/project/server/websockets"
)

func requireLogin(handler func(http.ResponseWriter, *http.Request, *database.DB, int64), db *database.DB) func(http.ResponseWriter, *http.Request) {
	validateLogin := func(w http.ResponseWriter, r *http.Request) {
		user_id, err := auth.GetUser(r, db)
		if err != nil {
			http.Error(w, err.Error(), http.StatusUnauthorized)
			return
		}
		handler(w, r, db, *user_id)
	}
	return validateLogin

}

func requireDB(handler func(http.ResponseWriter, *http.Request, *database.DB), db *database.DB) func(http.ResponseWriter, *http.Request) {
	return func(w http.ResponseWriter, r *http.Request) {
		handler(w, r, db)
	}
}


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
