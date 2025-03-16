package api

import (
	"encoding/json"
	"net/http"
	"tris.sh/project/server/database"
	"tris.sh/project/server/websockets"
)

type Request struct {
	Type websockets.ClipboardType
	Content string
}

func Paste(w http.ResponseWriter, r *http.Request, db *database.DB, user_id int) {
	var p Request
	err := json.NewDecoder(r.Body).Decode(&p)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	result, e := db.Write.Exec("INSERT INTO clipboards (user_id, clipboard, type) VALUES ($1, $2, $3)", user_id, p.Content, p.Type)
	if e != nil {
		http.Error(w, e.Error(), http.StatusInternalServerError)
		return
	}
	insert_id, e := result.LastInsertId()
	if e != nil {
		http.Error(w, e.Error(), http.StatusInternalServerError)
		return
	}
	
	websockets.Broadcast(websockets.ClipboardUpdate{
		Clipboard: websockets.Clipboard{Id: insert_id, Content: p.Content, Type: p.Type},
		Type: websockets.Add,
	}, user_id)
}
