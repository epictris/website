package api

import (
	"encoding/json"
	"fmt"
	"net/http"

	"tris.sh/project/server/database"
	"tris.sh/project/server/websockets"
)

type response struct {
	Clipboards []websockets.Clipboard
}

func GetClipboards(w http.ResponseWriter, r *http.Request, db *database.DB, user_id int) {
	fmt.Println("got request")

	var clipboards []websockets.Clipboard = []websockets.Clipboard{}

	
	rows, err := db.Read.Query("SELECT id, clipboard FROM clipboards WHERE user_id = ?", user_id);
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	for rows.Next() {
		var id int64
		var content string
		err := rows.Scan(&id, &content)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		clipboards = append(clipboards, websockets.Clipboard{Id: id, Content: content})
	}

	fmt.Println(clipboards)

	userJson, err := json.Marshal(response{Clipboards: clipboards})

	w.Write(userJson)

}
