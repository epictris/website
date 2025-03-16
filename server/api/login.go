package api

import (
	"context"
	"fmt"
	"log"
	"net/http"

	"github.com/google/uuid"
	"google.golang.org/api/idtoken"
	"tris.sh/project/server/database"
)

type LoginPage struct {
	BaseURL string
	Origin string
}

const GOOGLE_ID_TOKEN = "1048620241838-sj7ufqdd7gj1c9egnrcfhjknfonbei09.apps.googleusercontent.com"

func Login(w http.ResponseWriter, r *http.Request, db *database.DB) {
	if err := r.ParseForm(); err != nil {
		fmt.Fprintf(w, "ParseForm() err: %v", err)
		return
	}
	credential := r.FormValue("credential")


	payload, err := idtoken.Validate(context.Background(), credential, GOOGLE_ID_TOKEN)
	if err != nil {
		log.Print(err)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		return 
	}

	google_id := payload.Claims["sub"]
	_, err = db.Write.Exec("INSERT INTO users (google_id) VALUES ($1) ON CONFLICT DO NOTHING;", google_id)
	if err != nil {
		log.Fatal(err)
	}

	var user_id int
	db.Read.QueryRow("SELECT id FROM users where google_id = $1", google_id).Scan(&user_id)

	session_token := uuid.New().String()
	fmt.Println("generating new session token:", session_token)

	_, err = db.Write.Exec("INSERT INTO sessions (user_id, token) VALUES ($1, $2);", user_id, session_token)
	if err != nil {
		log.Fatal(err)
	}

	http.SetCookie(w, &http.Cookie{
		Name: "session_token",
		Value: session_token,
		HttpOnly: false,
		Path: "/",
	})
	http.Redirect(w, r, "/", http.StatusFound)
}
