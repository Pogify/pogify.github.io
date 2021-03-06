import React from "react";
import { observer } from "mobx-react";
import { playerStore, modalStore } from "../../stores";

import { Layout } from "../../layouts";

import Player from "../Player";
import WarningModal from "../../modals/WarningModal";
import Donations from "../utils/Donations";
import CopyLink from "../utils/CopyLink";

import styles from "./index.module.css";
import { showReportDialog } from "@sentry/react";
import { reaction } from "mobx";

/**
 * ListenerPlayer handles logic for listeners
 */
class ListenerPlayer extends React.Component {
  eventListenerRetry = 0;
  syncing = false;
  state = {
    device_id: "",
    loading: false,
    lastTimestamp: 0,
    updateTimestamp: 0,
    subConnected: false,
    hostUri: "",
    hostTrackWindow: [],
    hostConnected: false,
    hostPlaying: false,
    hostPosition: 0,
    // governs whether or not the player should play when host presses play.
    hostPausedWhileListenerListening: true,
    // governs whether or not players should start playing on connect
    firstPlay: false,
    synced: true,
    parked: false,
    changeSongCallback: null,
    // should always maintain sync toggle.
    strict: true,
  };

  /**
   * Sets event listeners from host
   */
  setListenerListeners = () => {
    // subscribe to events on backend
    this.setEventListener();

    // synchronization checker
    this.syncCheckDisposer = reaction(
      // only listen for these changes
      () => ({
        uri: playerStore.uri,
        diff: playerStore.diff,
        playing: playerStore.playing,
      }),
      // if listener player changed compare to host player
      ({ uri, playing }) => {
        if (this.syncing) {
          console.log("sync check blocked...");
          return;
        }
        console.log("checking sync");
        const {
          hostUri,
          hostPosition,
          hostPlaying,
          hostTrackWindow,
          updateTimestamp,
        } = this.state;
        let calcPos = hostPlaying
          ? hostPosition + Date.now() - updateTimestamp
          : hostPosition;
        if (
          hostUri !== uri ||
          Math.abs(calcPos - playerStore.position) > 1000 ||
          hostPlaying !== playing
        ) {
          console.log("not synced");
          this.setState(
            {
              synced: false,
            },
            async () => {
              let calcPos = hostPlaying
                ? hostPosition + Date.now() - updateTimestamp
                : hostPosition;
              // only update if player is in strict mode.
              // only update if host is connected
              // don't try and sync if host position goes past duration of the track
              if (
                this.state.hostConnected &&
                this.state.strict &&
                calcPos + 1000 < playerStore.data.duration
              ) {
                await this.syncListener(
                  hostUri,
                  calcPos,
                  hostPlaying,
                  hostTrackWindow
                );
              }
            }
          );
        } else {
          console.log("synced");
          this.setState({
            synced: true,
          });
        }
      },
      {
        // only react if the listener player changed
        equals: (a, b) => {
          if (a.uri !== b.uri || b.diff > 1000 || a.playing !== b.playing) {
            return false;
          }
          return true;
        },
      }
    );
  };

  setEventListener = () => {
    if ("EventSource" in window) {
      this.eventListener = new EventSource(
        process.env.REACT_APP_SUB + "/sub/" + this.props.sessionId + ".b1"
      );
    } else {
      // TODO: replace to nginx endpoint/ env var
      this.eventListener = new WebSocket(
        "ws://localhost/sub/" + this.props.sessionId
      );
    }

    // update state on open
    this.eventListener.onopen = () => {
      this.eventListenerRetry = 11;
      this.setState({
        subConnected: true,
      });
    };

    // message Handler
    this.eventListener.onmessage = async (event) => {
      console.log(event.data);
      let {
        timestamp,
        uri,
        position,
        playing,
        track_window: trackWindow,
      } = JSON.parse(event.data);
      // if message timestamp is less than previously received timestamp it is stale. don't act on it
      if (this.state.lastTimestamp > timestamp) return;

      // if there is a hostUri before but this
      if (this.state.hostUri && !uri) {
        this.setState({
          hostConnected: false,
        });
        modalStore.queue(
          <WarningModal
            title="Host disconnected."
            content="Playback has been paused"
          />
        );
        return;
      } else if (!uri) {
        // if first event is empty then post waiting for host
        this.setState({
          hostConnected: false,
        });
        return;
      }

      // calculate hosts current position based on hosts timestamp and time now on client
      let calcPos = playing ? position + Date.now() - timestamp : position;

      this.setState(
        {
          lastTimestamp: timestamp,
          hostUri: uri,
          hostTrackWindow: trackWindow,
          hostPosition: calcPos,
          updateTimestamp: Date.now(),
          hostPlaying: playing,
          firstPlay: playing || this.state.firstPlay,
          hostConnected: true,
        },
        async () => {
          // must call in callback else causes race conditions
          await this.syncListener(uri, calcPos, playing, trackWindow);
        }
      );
    };

    this.eventListener.onerror = (e) => {
      // if there is an error close connection and unset it
      this.eventListener = undefined;
      // if there are not many retries, increment counter then retry
      if (this.eventListenerRetry < 5) {
        this.eventListenerRetry++;
        setTimeout(() => {
          this.setEventListener();
        }, (this.eventListenerRetry / 5) ** 2 * 1000);
      } else {
        // if lots of retries show error modal.
        this.eventListenerRetry = 0;
        console.error(e);
        modalStore.queue(
          <WarningModal
            title="Failed to connect to Session"
            content={`Session ${this.props.sessionId} does not exist. Check that you have the proper session code and try again.`}
          >
            <div>
              <button onClick={showReportDialog}>Send an Error Report</button>
            </div>
          </WarningModal>
        );
      }
    };
  };

  /**
   * Initialize player as listener
   */
  connect = async () => {
    this.setState({ loading: true });

    // TODO: listener title based on session code?
    const playerDeviceId = await playerStore.initializePlayer(
      "Pogify Listener"
    );
    await playerStore.connectToPlayer(playerDeviceId).catch((err) => {
      if (err.message !== "Bad refresh token") {
        console.error(err);
      }
    });

    this.setState({ loading: false, spotConnected: true });
    // set listener event listeners
    this.setListenerListeners();
  };

  /**
   * Method syncs listener to provided params
   *
   * @param {string} uri spotify track uri
   * @param {number} position position in milliseconds
   * @param {boolean} playing playing state
   */
  async syncListener(uri, position, playing, trackWindow) {
    console.log("<<<< start sync");
    // because play/pause causes observable updates it triggers a run of the syncCheck reaction.
    // so set flag here until play/pause/newTrack is all encapsulated in an action.
    this.syncing = true;
    console.log(playing, position, playerStore.position);
    if (uri !== playerStore.uri) {
      console.log(uri, "!==", playerStore.uri);
      let indexOf = playerStore.track_window.indexOf(uri);

      if (indexOf === -1) {
        console.log("uri not in track window, fetching");
        await playerStore.newTrack(uri, position, playing, trackWindow);
      } else {
        let offset = indexOf - playerStore.trackOffset;
        if (offset !== 1) {
          console.log(
            "uri is in local track window but not next, skipping: ",
            offset
          );
        } else {
          console.log("uri is next in local track window, continuing");
        }
        await playerStore.skipTrack(offset);
      }
    } else {
      playerStore.seek(position);
      if (playing) {
        await playerStore.resume();
      } else {
        console.log("in");
        await playerStore.pause();
        console.log("out");
      }
    }
    this.setState(
      {
        synced: true,
      },
      () => {
        console.log(">>>> end sync");
        this.syncing = false;
      }
    );
  }

  componentWillUnmount() {
    // close connection to sub server
    if (this.eventListener) {
      this.eventListener.close();
    }
    // disconnect current player
    if (playerStore.player) {
      playerStore.player.disconnect();
    }
    // dispose sync check
    if (typeof this.syncCheckDisposer === "function") {
      this.syncCheckDisposer();
    }
  }

  render() {
    // if loading
    if (this.state.loading) {
      return (
        <Layout>
          <div>Loading...</div>
        </Layout>
      );
    }

    // if theres not a refresh token
    if (!window.localStorage.getItem("spotify:refresh_token")) {
      return (
        <Layout>
          <button onClick={this.connect}>Login with Spotify</button>
          <p>
            You'll be redirected to Spotify to login. After that, you'll
            automatically be connected to the room.
          </p>
        </Layout>
      );
    }

    // if the token is not valid, show the login screen
    if (playerStore.needsRefreshToken) {
      return (
        <Layout>
          <div className="textAlignCenter">
            <button onClick={this.initializePlayer}>Login with Spotify</button>
            <p>
              You've been disconnected from Spotify. Click on the button to
              login again.
            </p>
          </div>
        </Layout>
      );
    }

    // if any are false show join
    if (!this.state.spotConnected || !this.state.subConnected) {
      return (
        <Layout>
          <button onClick={this.connect}>Join Session</button>
        </Layout>
      );
    }

    // waiting for host view.
    if (!this.state.hostConnected || !this.state.firstPlay) {
      return (
        <Layout>
          <h2 className={styles.h2}>Waiting for host to play music...</h2>{" "}
          <p>Session Code: {this.props.sessionId}</p>
          <input
            type="checkbox"
            name="dontPlay"
            id="dontPlay"
            value={!this.state.hostPausedWhileListenerListening}
            onChange={() =>
              this.setState({
                hostPausedWhileListenerListening: !this.state
                  .hostPausedWhileListenerListening,
              })
            }
          />
          <label htmlFor="dontPlay">Don't Auto-play.</label>
        </Layout>
      );
    }

    return (
      <Layout noBackground noBlockPadding>
        <div className={styles.container}>
          <div className={styles.titleBar}>
            <h1>{this.props.sessionId}</h1>
            <div className={styles.linkWrapper}>
              <div className={styles.shareExplanations}>
                Share the URL below to listen with others:
                <br />
                <CopyLink
                  href={window.location.href}
                  className={styles.shareLink}
                  title="Click to copy and share to your audience"
                >
                  {window.location.href}
                </CopyLink>
              </div>
            </div>
          </div>
          <Player isHost={false} warn={!this.state.synced} />

          <div className={styles.infoBar}>
            <div className={styles.info}>
              <span className={styles.infoBold}>
                Please do not close this tab.
              </span>
              <br />
              Your playback is controlled by the host. If you control playback
              on a different Spotify client, you will be resynchronized with the
              host automatically. If you want to pause while staying in sync,
              please simply mute.
            </div>
            <div className={`${styles.donations} ${styles.info}`}>
              Do you like what we're doing? Help us our with a donation to keep
              our dev servers running! Even just one dollar will help.
              <div>
                <Donations noText />
              </div>
            </div>
          </div>
        </div>
      </Layout>
    );
  }
}

export default observer(ListenerPlayer);
