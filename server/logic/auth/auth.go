package auth

import (
	"context"
	"net/http"
	"tris.sh/project/server/database"
	"google.golang.org/api/idtoken"
	"github.com/google/uuid"
)

const googleIdToken = "1048620241838-sj7ufqdd7gj1c9egnrcfhjknfonbei09.apps.googleusercontent.com"

func validateSessionToken(r *http.Request, db *database.DB) (*int64, error) {
	var user_id int64
	cookie, err := r.Cookie("session_token")
	if err != nil {
		return nil, err
	}
	session_token := cookie.Value
	err = db.Read.QueryRow(`
		SELECT user_id
		FROM sessions
		WHERE token = $1 
		AND created_at > DATETIME(CURRENT_TIMESTAMP, '-1440 minutes');
	`, session_token).Scan(&user_id)
	if err != nil {
		return nil, err
	}
	return &user_id, nil
}

func validateGoogleAuth(r *http.Request, db *database.DB) (*int64, error) {
	credential := r.FormValue("credential")
	payload, err := idtoken.Validate(context.Background(), credential, googleIdToken)
	if err != nil {
		return nil, err
	}
	google_id := payload.Claims["sub"]
	_, err = db.Write.Exec(`
		INSERT INTO users (google_id) 
		VALUES ($1) 
		ON CONFLICT DO NOTHING;
	`, google_id)
	if err != nil {
		return nil, err
	}
	var user_id int64
	err = db.Read.QueryRow(`
		SELECT id 
		FROM users 
		WHERE google_id = $1
	`, google_id).Scan(&user_id)
	if err != nil {
		return nil, err
	}
	return &user_id, nil
}


func GetUser(r *http.Request, db *database.DB) (*int64, error) {
	var user_id *int64
	user_id, err := validateSessionToken(r, db)
	if err == nil {
		return user_id, nil
	}
	user_id, err = validateGoogleAuth(r, db)
	if err == nil {
		return user_id, nil
	}
	return nil, err
}
