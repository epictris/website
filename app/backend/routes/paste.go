package routes

import (
	"fmt"
	"net/http"
)
func Paste(w http.ResponseWriter, r *http.Request) {
	fmt.Println("copy")
}
