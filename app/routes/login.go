package routes

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"text/template"
	"time"

	"github.com/google/uuid"
	"google.golang.org/api/idtoken"
	"tris.sh/project/app/client"
	"tris.sh/project/app/database"
	"tris.sh/project/app/env"
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
	origin := r.FormValue("origin")
	credential := r.FormValue("credential")


	payload, err := idtoken.Validate(context.Background(), credential, GOOGLE_ID_TOKEN)
	if err != nil {
		log.Print(err)
		t, err := template.ParseFS(client.BuildFS, "templates/login.html")
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		t.Execute(w, LoginPage{BaseURL: env.DEPLOY_ENV, Origin: origin})
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

	_, err = db.Write.Exec("INSERT INTO sessions (user_id, token) VALUES ($1, $2);", user_id, session_token)
	if err != nil {
		log.Fatal(err)
	}

	http.SetCookie(w, &http.Cookie{
		Name: "session_token",
		Value: session_token,
		Expires: time.Now().Add(time.Hour * 24),
	})
	http.Redirect(w, r, origin, http.StatusFound)
}
