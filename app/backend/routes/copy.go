package routes

import (
	"fmt"
	"net/http"
	"strings"

	"tris.sh/project/app/backend/database"
)

const COPY_PAGE = `
<html>
	<body>
		<script>
			document.addEventListener('DOMContentLoaded', async() => {
				try {
					await navigator.clipboard.writeText(%s);
					console.log('Copied to clipboard');
				} catch (err) {
					console.error('Failed to copy to clipboard');
				}
			});
		</script>
	</body>
</html>
`

func Copy(w http.ResponseWriter, r *http.Request, db *database.DB, user_id int) {
	var clipboard string
	db.Read.QueryRow("SELECT clipboard FROM users WHERE id = ?", user_id).Scan(&clipboard)
	fmt.Fprintf(w, COPY_PAGE, "`" + strings.ReplaceAll(clipboard, "`", "\\`") + "`")
}
