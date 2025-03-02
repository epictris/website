package routes

import (
	"context"
	"fmt"
	"log"
	"net/http"

	"github.com/google/uuid"
	"google.golang.org/api/idtoken"
	"tris.sh/project/app/backend/database"
)

const LOGIN_PAGE = `
<html>
	<body style="margin: 0">
		<script src="https://accounts.google.com/gsi/client" async></script>
		<div id="g_id_onload"
			 data-client_id="1048620241838-sj7ufqdd7gj1c9egnrcfhjknfonbei09.apps.googleusercontent.com"
			 data-login_uri="http://localhost:8080/login"
			 data-context="signin"
			 data-ux_mode="popup"
			 data-auto_select="true"
			 data-itp_support="true"
			 data-close_on_tap_outside="false"
			 data-origin="%s">
		</div>
	<div class="g_id_signin" style="display:flex; justify-content: center; height: 100vh; align-items: center;"
				 data-type="standard"
				 data-shape="rectangular"
				 data-theme="outline"
				 data-text="signin_with"
				 data-size="large"
				 data-logo_alignment="left">
			</div>
	</body>
</html>
`
const GOOGLE_ID_TOKEN = "1048620241838-sj7ufqdd7gj1c9egnrcfhjknfonbei09.apps.googleusercontent.com"

func Login(w http.ResponseWriter, r *http.Request, db *database.DB) {
	if err := r.ParseForm(); err != nil {
		fmt.Fprintf(w, "ParseForm() err: %v", err)
		return
	}
	origin := r.FormValue("origin")
	credential := r.FormValue("credential")

	payload, err := idtoken.Validate(context.Background(), credential, GOOGLE_ID_TOKEN)
	if err != nil {
		fmt.Fprintf(w, LOGIN_PAGE, origin)
		return 
	}

	google_id := payload.Claims["sub"]
	_, err = db.Write.Exec("INSERT INTO users (google_id) VALUES ($1) ON CONFLICT DO NOTHING;", google_id)
	if err != nil {
		log.Fatal(err)
	}

	var user_id int
	db.Read.QueryRow("SELECT id FROM users where google_id = $1", google_id).Scan(&user_id)

	session_token := uuid.New().String()

	_, err = db.Write.Exec("INSERT INTO sessions (user_id, token) VALUES ($1, $2);", user_id, session_token)
	if err != nil {
		log.Fatal(err)
	}

	http.SetCookie(w, &http.Cookie{
		Name: "session_token",
		Value: session_token,
	})
	http.Redirect(w, r, origin, http.StatusFound)
}
