package routes

import (
	"html/template"
	"net/http"

	"tris.sh/project/app/client"
	"tris.sh/project/app/database"
	"tris.sh/project/app/env"
)

type CopyPage struct {
	EncodedClipboard string
	BaseURL string
}

func Copy(w http.ResponseWriter, r *http.Request, db *database.DB, user_id int) {
	var clipboard string
	db.Read.QueryRow("SELECT clipboard FROM users WHERE id = ?", user_id).Scan(&clipboard)
	t, err := template.ParseFS(client.BuildFS, "templates/clipboard.html")
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	t.Execute(w, CopyPage{EncodedClipboard: clipboard, BaseURL: env.DEPLOY_ENV})
}
