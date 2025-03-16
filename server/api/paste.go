package api

import (
	"encoding/json"
	"fmt"
	"net/http"

	"tris.sh/project/server/database"
	"tris.sh/project/server/websockets"
)

type Request struct {
	Value string
}

func Paste(w http.ResponseWriter, r *http.Request, db *database.DB, user_id int) {
	var p Request
	err := json.NewDecoder(r.Body).Decode(&p)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	result, e := db.Write.Exec("INSERT INTO clipboards (user_id, clipboard) VALUES ($1, $2)", user_id, p.Value)
	if e != nil {
		http.Error(w, e.Error(), http.StatusInternalServerError)
		return
	}
	insert_id, e := result.LastInsertId()
	if e != nil {
		http.Error(w, e.Error(), http.StatusInternalServerError)
		return
	}
	
	fmt.Println(p.Value)

	websockets.Broadcast(websockets.ClipboardUpdate{
		Clipboard: websockets.Clipboard{Id: insert_id, Content: p.Value},
		Type: websockets.Add,
	}, user_id)
}
