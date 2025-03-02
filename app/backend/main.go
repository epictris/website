package main

import (
	"fmt"
	"log"
	"net/http"
	"tris.sh/project/app/backend/routes"
)

func requireLogin(url string, handler func(http.ResponseWriter, *http.Request)) func(http.ResponseWriter, *http.Request) {

	validateLogin := func(w http.ResponseWriter, r *http.Request) {
		c, err := r.Cookie("session_token")
		redirect_url := fmt.Sprintf("/login?origin=%s", url)
		if err != nil {
			if err == http.ErrNoCookie {
				fmt.Println("Unauthorized")
				http.Redirect(w, r, redirect_url, http.StatusFound)
				return
			}
			fmt.Println("Bad Request")
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		session_token := c.Value
		if session_token != "123456" {
			http.Redirect(w, r, redirect_url, http.StatusFound)
		}
		handler(w, r)
	}
	return validateLogin

}

func registerRoute(url string, handler func(http.ResponseWriter, *http.Request)) {
	http.HandleFunc(url, requireLogin(url, handler))
}


func main() {
	file_server := http.FileServer(http.Dir("app/static"))
	http.Handle("/", file_server)
	http.HandleFunc("/login", routes.Login)
	registerRoute("/copy", routes.Copy)
	registerRoute("/paste", routes.Paste)

	fmt.Println("Starting server at port 8080")

	if err:= http.ListenAndServe(":8080", nil); err != nil {
		log.Fatal(err)
	}
}
