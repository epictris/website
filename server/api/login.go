package api

import (
	"log"
	"net/http"

	"github.com/google/uuid"
	"tris.sh/project/server/database"
	"tris.sh/project/server/logic/auth"
)

type LoginPage struct {
	BaseURL string
	Origin string
}


func initUserSession(user_id int64, w http.ResponseWriter, db *database.DB) error {
	session_token := uuid.New().String()
	_, err := db.Write.Exec(`
		INSERT INTO sessions (user_id, token)
		VALUES ($1, $2);
	`, user_id, session_token)
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
	user_id, err := auth.GetUser(r, db)
	if err != nil {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	err = initUserSession(*user_id, w, db)
	if err != nil {
		log.Println(err)
		w.WriteHeader(http.StatusInternalServerError)
		return
	}
	http.Redirect(w, r, "/", http.StatusFound)
}
