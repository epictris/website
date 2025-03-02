package main

import (
	"context"
	"fmt"
	"log"
	"net/http"

	"google.golang.org/api/idtoken"
)


func main() {
	fileServer := http.FileServer(http.Dir("./frontend"))
	http.Handle("/", fileServer)
	http.HandleFunc("/copy", copyHandler)
	http.HandleFunc("/login", loginHandler)

	fmt.Println("Starting server at port 8080")

	if err:= http.ListenAndServe(":8080", nil); err != nil {
		log.Fatal(err)
	}
}
