import React from "react";
import { Link } from "react-router-dom";
import "../styles/Layout.css";
import { observer } from "mobx-react"
import { themeStore } from "../stores";

/** 
 * Default layout component. 
 * Center content view with footer 
 */
function Layout(props) {
  let { theme/*, toggleTheme*/ } = themeStore

  let contentClass = "content";
  const darkMode = theme === "dark"
  if (darkMode) {
    contentClass += " darkContent";
  }
  if (props.noBackground) {
    contentClass += " noBackground";
  }

  return (
    <div className="layout">
      <header className="header">
        <div className="pogifyLogo">
          <img alt="Pogify Logo" className="pogifyLogoImage" src="/logo192.png"></img>
          <p className="pogifyLogoText">POGIFY</p>
        </div>
        <div className="themeContainer">
          <p className="themeText">Theme</p>
          <button className="themeSwitch"></button>
        </div>
      </header>
      <div className={contentClass}>{props.children}</div>
      <footer className="footer">
        <div className="footer-links">
          <Link to="/tou">Terms of Use</Link>
          <Link to="/privacy">Privacy Policy</Link>
          <a href="https://github.com/Pogify/pogify">GitHub</a>
        </div>
        <p><a href="https://www.spotify.com">Spotify</a> is copyright Spotify AB and is not affiliated with Pogify</p>
      </footer>
    </div>

  )
}

export default observer(Layout)