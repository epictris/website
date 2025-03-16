package api

import (
	"context"
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

func checkSessionToken(r *http.Request, db *database.DB) error {
	cookie, err := r.Cookie("session_token")
	if err != nil {
		return err
	}
	session_token := cookie.Value
	var user_id int
	err = db.Read.QueryRow("SELECT user_id FROM sessions where token = $1 and created_at > DATETIME(CURRENT_TIMESTAMP, '-1440 minutes');", session_token).Scan(&user_id)
	if err != nil {
		return err
	}
	return nil
}

func checkGoogleAuth(r *http.Request, db *database.DB) (*int64, error) {
	credential := r.FormValue("credential")
	payload, err := idtoken.Validate(context.Background(), credential, GOOGLE_ID_TOKEN)
	if err != nil {
		return nil, err
	}
	google_id := payload.Claims["sub"]
	_, err = db.Write.Exec("INSERT INTO users (google_id) VALUES ($1) ON CONFLICT DO NOTHING;", google_id)
	if err != nil {
		return nil, err
	}
	var user_id int64
	err = db.Read.QueryRow("SELECT id FROM users WHERE google_id = $1", google_id).Scan(&user_id)
	if err != nil {
		return nil, err
	}
	return &user_id, nil
}

func initUserSession(user_id int64, w http.ResponseWriter, r *http.Request, db *database.DB) error {
	session_token := uuid.New().String()
	_, err := db.Write.Exec("INSERT INTO sessions (user_id, token) VALUES ($1, $2);", user_id, session_token)
	if err != nil {
		return err
	}

	http.SetCookie(w, &http.Cookie{
		Name: "session_token",
		Value: session_token,
		HttpOnly: false,
		Path: "/",
	})
	return nil
}

func Login(w http.ResponseWriter, r *http.Request, db *database.DB) {
	err := checkSessionToken(r, db)
	if err == nil {
		w.WriteHeader(http.StatusOK)
		return
	}

	user_id, err := checkGoogleAuth(r, db)
	if err != nil {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}

	err = initUserSession(*user_id, w, r, db)
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		log.Println(err)
		return
	}
	http.Redirect(w, r, "/", http.StatusFound)
}
