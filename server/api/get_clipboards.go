package api

import (
	"encoding/json"
	"net/http"

	"tris.sh/project/server/database"
	"tris.sh/project/server/websockets"
)

type response struct {
	Clipboards []websockets.Clipboard
}

func GetClipboards(w http.ResponseWriter, r *http.Request, db *database.DB, user_id int64) {

	var clipboards []websockets.Clipboard = []websockets.Clipboard{}

	
	rows, err := db.Read.Query(`
		SELECT id, clipboard, type 
		FROM clipboards 
		WHERE user_id = ? 
		ORDER BY id ASC
		`, user_id);
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	for rows.Next() {
		var id int64
		var content string
		var clipboard_type string
		err := rows.Scan(&id, &content, &clipboard_type)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		clipboards = append(clipboards, websockets.Clipboard{Id: id, Content: content, Type: websockets.ClipboardType(clipboard_type)})
	}

	userJson, err := json.Marshal(response{Clipboards: clipboards})

	w.Write(userJson)

}
