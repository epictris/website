package api

import (
	"encoding/json"
	"net/http"

	"tris.sh/project/app/backend/database"
)

type Request struct {
	Clipboard string
}

func Paste(w http.ResponseWriter, r *http.Request, db *database.DB, user_id int) {
	var p Request
	err := json.NewDecoder(r.Body).Decode(&p)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	db.Write.Exec("UPDATE users set clipboard = ? where id = ?", p.Clipboard, user_id)
}
