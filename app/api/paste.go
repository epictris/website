package api

import (
	"encoding/base64"
	"encoding/json"
	"net/http"

	"tris.sh/project/app/database"
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

	encoded_clipboard := base64.StdEncoding.EncodeToString([]byte(p.Clipboard))

	db.Write.Exec("UPDATE users set clipboard = ? where id = ?", encoded_clipboard, user_id)
}
