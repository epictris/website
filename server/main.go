package main

import (
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"

	"github.com/google/uuid"
	"tris.sh/project/client"
	"tris.sh/project/server/websockets"
)
func serveSpa(w http.ResponseWriter, r *http.Request) {
	buildPath := "dist"

	_, err := r.Cookie("session_token")

	if err != nil {
		http.SetCookie(w, &http.Cookie{
			Name: "session_token",
			Value:	uuid.New().String(),
			HttpOnly: false,
			Path: "/",
		})
	}

	path, err := client.BuildFS.Open(filepath.Join(buildPath, r.URL.Path))
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
	http.HandleFunc("/ws", websockets.HandleWebsocket)
	http.HandleFunc("/", serveSpa)

	websockets.Init()

	fmt.Println("Starting server at port 8080")

	if err:= http.ListenAndServe(":8080", nil); err != nil {
		log.Fatal(err)
	}
}
