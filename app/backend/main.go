package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"tris.sh/project/app/env"
	"tris.sh/project/app/backend/database"
	"tris.sh/project/app/backend/routes"
)

func requireLogin(url string, handler func(http.ResponseWriter, *http.Request), db *database.DB) func(http.ResponseWriter, *http.Request) {

	validateLogin := func(w http.ResponseWriter, r *http.Request) {
		c, err := r.Cookie("session_token")
		redirect_url := fmt.Sprintf("/login?origin=%s", url)
		if err != nil {
			if err == http.ErrNoCookie {
				fmt.Println("Unauthorized")
				http.Redirect(w, r, redirect_url, http.StatusFound)
				return
			}
			fmt.Println("Bad Request")
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		session_token := c.Value
		var user_id int
		err = db.Read.QueryRow("SELECT user_id FROM sessions where token = $1 and created_at > DATETIME(CURRENT_TIMESTAMP, '-1 minutes');", session_token).Scan(&user_id)
		if err != nil {
			http.Redirect(w, r, redirect_url, http.StatusFound)
		}
		handler(w, r)
	}
	return validateLogin

}

func withDBConnection(handler func(http.ResponseWriter, *http.Request, *database.DB), db *database.DB) func(http.ResponseWriter, *http.Request) {
	return func(w http.ResponseWriter, r *http.Request) {
		handler(w, r, db)
	}
}

func registerRoute(url string, handler func(http.ResponseWriter, *http.Request, *database.DB), db *database.DB, require_auth bool) {
	if require_auth {
		http.HandleFunc(url, requireLogin(url, withDBConnection(handler, db), db))
	} else {
		http.HandleFunc(url, withDBConnection(handler, db))
	}
}


func main() {
	file_server := http.FileServer(http.Dir("app/static"))
	db, err := database.New(context.Background(), env.DATA_DIR + "/sqlite.db")
	if err != nil {
		log.Fatal(err)
	}
	database.Init(db)
	http.Handle("/", file_server)
	registerRoute("/login", routes.Login, db, false)
	registerRoute("/copy", routes.Copy, db, true)
	registerRoute("/paste", routes.Paste, db, true)

	fmt.Println("Starting server at port 8080")

	if err:= http.ListenAndServe(":8080", nil); err != nil {
		log.Fatal(err)
	}
}
