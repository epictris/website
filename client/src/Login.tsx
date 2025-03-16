import { createEffect, type Component } from 'solid-js';
const Login: Component = () => {

  createEffect(() => {
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.defer = true;
    document.body.appendChild(script);
    return () => {
      document.body.removeChild(script);
    }
  }, [])

  return (<div>
		<div id="g_id_onload"
			 data-client_id="1048620241838-sj7ufqdd7gj1c9egnrcfhjknfonbei09.apps.googleusercontent.com"
			 data-login_uri={window.location.origin + "/api/login"}
			 data-context="signin"
			 data-auto_select="true"
			 data-itp_support="true"
			 data-close_on_tap_outside="false">
		</div>
	<div class="g_id_signin" style="display:flex; justify-content: center; height: 100vh; align-items: center;"
				 data-type="standard"
				 data-shape="rectangular"
				 data-theme="outline"
				 data-text="signin_with"
				 data-size="large"
				 data-logo_alignment="left">
			</div>
            </div>
  )
};

export default Login;
