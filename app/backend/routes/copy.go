package routes

import (
	"fmt"
	"net/http"
)
func Copy(w http.ResponseWriter, r *http.Request) {
	fmt.Println("copy")
}
