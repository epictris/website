package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"tris.sh/project/app/api"
	"tris.sh/project/app/database"
	"tris.sh/project/app/routes"
	"tris.sh/project/app/env"
)

func requireLogin(url string, handler func(http.ResponseWriter, *http.Request, *database.DB, int), db *database.DB) func(http.ResponseWriter, *http.Request) {
	validateLogin := func(w http.ResponseWriter, r *http.Request) {
		c, err := r.Cookie("session_token")
		fmt.Println("validating login to url: ", url)
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
		err = db.Read.QueryRow("SELECT user_id FROM sessions where token = $1 and created_at > DATETIME(CURRENT_TIMESTAMP, '-1440 minutes');", session_token).Scan(&user_id)
		if err != nil {
			http.Redirect(w, r, redirect_url, http.StatusFound)
		}
		handler(w, r, db, user_id)
	}
	return validateLogin

}

func requireDB(handler func(http.ResponseWriter, *http.Request, *database.DB), db *database.DB) func(http.ResponseWriter, *http.Request) {
	return func(w http.ResponseWriter, r *http.Request) {
		handler(w, r, db)
	}
}

type Test struct {
	Name string
}


func main() {
	db, err := database.New(context.Background(), env.DATA_DIR + "/sqlite.db")
	if err != nil {
		log.Fatal(err)
	}
	database.Init(db)
	http.HandleFunc("/login", requireDB(routes.Login, db))
	http.HandleFunc("/clipboard", requireLogin("/clipboard", routes.Copy, db))
	http.HandleFunc("/api/paste", requireLogin("/api/paste", api.Paste, db))

	fmt.Println("Starting server at port 8080")

	if err:= http.ListenAndServe(":8080", nil); err != nil {
		log.Fatal(err)
	}
}
