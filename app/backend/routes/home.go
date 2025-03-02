package routes

import (
	"net/http"
	"os"
)
func Home(w http.ResponseWriter, r *http.Request) {
	const file_path = "app/static/home.html"
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
	http.ServeContent(w, r, fileInfo.Name(), fileInfo.ModTime(), file)
}
