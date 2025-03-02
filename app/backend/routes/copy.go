package routes

import (
	"fmt"
	"net/http"

	"tris.sh/project/app/backend/database"
)
func Copy(w http.ResponseWriter, r *http.Request, db *database.DB) {
	fmt.Println("copy")
}
