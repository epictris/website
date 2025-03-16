/* @refresh reload */
import { render } from 'solid-js/web';
import { Route, Router } from '@solidjs/router';

import './index.css';
import App from './App';
import Login from './Login';
import { useNavigate } from '@solidjs/router';
import { Component } from 'solid-js';

const root = document.getElementById('root');

if (import.meta.env.DEV && !(root instanceof HTMLElement)) {
  throw new Error(
    'Root element not found. Did you forget to add it to your index.html? Or maybe the id attribute got misspelled?',
  );
}

const validateLogin = function (page: Component): Component {
  const validator: Component = (props) => {
    const navigate = useNavigate();
    fetch(document.location.origin + '/api/login').then((response) => {
      if (response.status == 401) {
        throw navigate("/login");
      }  });
    return page(props)
  }
  return validator;
}

render(() => (
    <Router> 
      <Route path="/" component={validateLogin(App)} />
      <Route path="/login" component={Login} />
    </Router>
  ), root!);
