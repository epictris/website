package routes

import (
	"fmt"
	"net/http"
	"os"
	"time"

	"tris.sh/project/app/backend/database"
)
func Paste(w http.ResponseWriter, r *http.Request, db *database.DB, user_id int) {
	fmt.Println("user id:")
	fmt.Println(user_id)
	const file_path = "app/static/paste.html"
	file, err := os.Open(file_path)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	defer file.Close()
	fileInfo, err := file.Stat()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	http.ServeContent(w, r, fileInfo.Name(), time.Unix(0, 0), file)
}
