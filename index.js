const express = require('express');
const axios = require('axios');
var { google } = require('googleapis');
const bodyParser = require('body-parser');
const schedule = require('node-schedule');

const app = express();
const PORT = process.env.PORT || 8087;

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

let ytSearchesLeft = 100;
/* "Projects that enable the YouTube Data API have a default quota allocation of 10,000 units per day"
  "A search request costs 100 units."
  https://developers.google.com/youtube/v3/getting-started#quota */

// A daily CRON job that resets the number of available youtube searches back to 100
schedule.scheduleJob('0 2 * * *', () => {
  ytSearchesLeft = 100;
  console.log('Daily reset of Youtube search count remainder');
});

const poi = process.env.POI; // Person if interest - streamer's Spotify id
const redirectUrl = process.env.REDIRECT_URL; // A URL to redirect to after user grants us permission
const clientId = process.env.CLIENT_ID; // ID of our Spotify app
const clientSecret = process.env.CLIENT_SECRET; // Our Spotify app secret

// Keeping track of both tokens in the app
let accessToken = undefined; // A token that is sent with every request - valid for an hour
let refreshToken = undefined; // A token that is  used to fetch a new access_token once the old one expires

// Postgres pool
// We also keep track of the spotify users that authorized us in the database to preserve the information unpon redeploying the application
const Pool = require('pg').Pool;
const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_DATABASE,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
});

// 7TV emotes used in the messages
let emote = 'Vibe';
let emotes = [
  'peepoDJ',
  'xddJAM',
  'Dance',
  'danse',
  'Jigglin',
  'duckass',
  'yoshiJAM',
  'danseparty',
  'FloppaJAM',
  'catRAVE',
  'xar2EDM',
  'KEKVibe',
  'Jamgie',
  'Vibe',
];

// Keeping track of the latest fetched song info to prevent unnecessary youtube searches
let currentSong = {
  title: null,
  artist: null,
  youtubeId: null, // ID of the yt video
};

// A function returning a random emote
function randomEmote() {
  return emotes?.[Math.floor(Math.random() * emotes?.length)];
}

// The function called when we (re)start the app to fetch the saved tokens from the db. If they aren't in the db we have not been authorized yet.
const getStreamerTokens = () => {
  pool
    .query(`SELECT * FROM users WHERE username = '${poi}';`)
    .then((res) => {
      if (res?.rowCount === 1) {
        // This Spotify user authorized us.
        console.log(
          `(Re)start of the node app - we are already authorized and fetched the tokens from the db AT: ${res?.rows?.[0]?.access_token}, RT: ${res?.rows?.[0]?.refresh_token} `
        );
        didPoiAuthUs = true;
        accessToken = res?.rows?.[0]?.access_token;
        refreshToken = res?.rows?.[0]?.refresh_token;
      } else {
        // We have not yet been authorized by this Spotify user.
        console.log(
          'The attempt to fetch token from the db failed - We are not authorized.'
        );
      }
    })
    .catch((err) => {
      console.log('db query error: ', err);
    });
};

// Call the function
getStreamerTokens();

// Our node app listening
app.listen(PORT, function () {
  console.log(`App listening on port ${PORT}!`);
});

// A function that is called when someone is authorizing our app
const getTokens = (code, nodeRes) => {
  axios({
    method: 'post',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    url: 'https://accounts.spotify.com/api/token',
    data: {
      grant_type: 'authorization_code',
      code: code,
      redirect_uri: redirectUrl,
      client_id: clientId,
      client_secret: clientSecret,
    },
  })
    .then((res) => {
      console.log('getTokens response: ', res?.data);
      let innerAccessToken = res?.data?.access_token;
      let innerRefreshToken = res?.data?.refresh_token;

      // Authorization was successful - We have to check if this is the streamer authorizing us or someone else
      axios({
        method: 'get',
        headers: {
          Authorization: `Authorization: Bearer ${res?.data?.access_token}`,
        },

        url: 'https://api.spotify.com/v1/me',
      })
        .then((res) => {
          console.log('This is the user authorizing our app: ', res?.data);
          if (res?.data?.id == poi) {
            // The user authorizing us matches our person of interest (the streamer)
            console.log('We were authorized by the POI.');
            accessToken = innerAccessToken;
            refreshToken = innerRefreshToken;
            didPoiAuthUs = true;

            pool
              .query(`SELECT * FROM users WHERE username = '${poi}';`)
              .then((res) => {
                if (res?.rowCount === 1) {
                  // re-authorization - update both tokens
                  console.log('Re-authorization - update both tokens');
                  pool
                    .query(
                      `UPDATE users SET access_token = '${innerAccessToken}', refresh_token = '${innerRefreshToken}' WHERE username = '${poi}';`
                    )
                    .then((res) => {
                      console.log(
                        `tokens updated for ${poi} after re-authorization: `,
                        res
                      );
                      nodeRes.set('Content-Type', 'text-html');
                      nodeRes.send(
                        Buffer.from(
                          '<div>Authorization successful! "!song" command was enabled for your Twitch chat. :)</div>'
                        )
                      );
                    })
                    .catch((err) => {
                      console.log(
                        `error while re-authorizing for ${poi}:  `,
                        err
                      );
                    });
                } else {
                  // first authorization
                  pool
                    .query(
                      `INSERT INTO users (username, access_token, refresh_token) VALUES ('${poi}', '${innerAccessToken}', '${innerRefreshToken}');`
                    )
                    .then((res) => {
                      console.log(
                        `First time authorization for the user ${poi}. Access_token ${innerAccessToken} and refresh_token ${innerRefreshToken} have been inserted into the db.`
                      );
                      nodeRes.set('Content-Type', 'text-html');
                      nodeRes.send(
                        Buffer.from(
                          '<div>Authorization successful! "!song" command was enabled for your Twitch chat. :)</div>'
                        )
                      );
                    })
                    .catch((err) => {
                      console.log(
                        `We attempted to insert ${poi} into the db for theis first authorization with access_token ${innerAccessToken} and refresh_token ${innerRefreshToken} but an error occurred: `,
                        err
                      );
                    });
                }
              })
              .catch((err) => {
                console.log('error fetching records from the db:', err);
              });
          } else {
            console.log(
              'A user that is not our POI authorized us:',
              res?.data?.id
            );
            nodeRes.set('Content-Type', 'text-html');
            nodeRes.send(
              Buffer.from(
                '<div>You are not on the list of allowed streamers. :(</div>'
              )
            );
          }
        })
        .catch((err) => {
          console.log('error in the /me call: ', err);
        });
    })
    .catch((err) => {
      console.log(
        'error while attempting to authorize us: ',
        err?.response?.data
      );
      nodeRes.set('Content-Type', 'text-html');
      nodeRes.send(
        Buffer.from(
          '<div>An error occurred during the authorization. Go to https://www.spotify.com/account/apps/, click on the "remove access" button next to the "Twitch Plus Spotify" app and refresh this page.</div>'
        )
      );
    });
};

// A function for JSON response
const getCurrentSongJson = (nodeRes) => {
  emote = randomEmote();

  // Fetch the current song
  axios({
    method: 'get',
    headers: {
      Authorization: `Authorization: Bearer ${accessToken}`,
    },
    url: 'https://api.spotify.com/v1/me/player/currently-playing',
  })
    .then((res) => {
      if (res?.status === 204 && res?.statusText === 'No Content') {
        // Streamer's Spotify is not playing any songs
        console.log(
          'API call while streamer is not playing anything on Spotify.'
        );
        nodeRes.status(500).json({
          errorMessage:
            'Streamer is currently not playing any music on Spotify.',
        });
      } else {
        // There is music playing on the streamer's Spotify
        if (currentSong?.title === res?.data?.item?.name) {
          // Not the first person asking about this song (in this playthrough of the song at least)
          emote = randomEmote();
          if (currentSong?.youtubeId === 'notfound') {
            // We haven't found anything on TY for this song
            console.log(
              'API call for a song that has been checked before - without YT link'
            );
            nodeRes.json({
              full: `${emote} "${currentSong.title}" by "${currentSong.artist}" ${emote}`,
              title: currentSong.title,
              artist: currentSong.artist,
              youtubeLink: '/',
              emote: emote,
            });
          } else {
            console.log(
              'API call for a song that has been checked before - with YT link'
            );
            nodeRes.json({
              full: `${emote} "${currentSong.title}" by "${currentSong.artist}" - https://youtu.be/${currentSong.youtubeId} ${emote}`,
              title: currentSong.title,
              artist: currentSong.artist,
              youtubeLink: `https://youtu.be/${currentSong.youtubeId}`,
              emote: emote,
            });
          }
        } else {
          // This is the first query for this song, set the artist and title and search TY for a video of the song
          let artistString = buildArtistString(res?.data?.item?.artists);
          currentSong.title = res?.data?.item?.name;
          currentSong.artist = artistString;
          return getYoutubeIdJson(res?.data?.item?.name, artistString, nodeRes);
        }
      }
    })
    .catch((err) => {
      if (err?.response?.data?.error?.status === 401) {
        // If there is an error with this call we have to check for 401 since access token expires every hour

        // Since access token has expired we have to refresh it and call the getCurrentSong again
        axios({
          method: 'post',
          headers: {
            Authorization:
              'Basic ' +
              new Buffer.from(clientId + ':' + clientSecret).toString('base64'),
            'content-type': 'application/x-www-form-urlencoded',
          },
          url: 'https://accounts.spotify.com/api/token',
          data: {
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
          },
        })
          .then((res) => {
            console.log(
              '(API call) Access token successfully refreshed. New access token: ',
              res?.data?.access_token
            );

            // New access token that we got from the refresh has to be set in the app and in the db
            accessToken = res?.data?.access_token;

            pool
              .query(
                `UPDATE users SET access_token = '${res?.data?.access_token}' WHERE username = '${poi}';`
              )
              .then((res) => {
                console.log(
                  `(API call) Successfuly updated the new access_token in the db after expiry for ${poi} `
                );
              })
              .catch((err) => {
                console.log(
                  `(API call) Updating the expired access_token in the db failed for ${poi}:  `,
                  err
                );
              });

            // Calling the getCurrentSong again with the new token
            getCurrentSongJson(nodeRes);
          })
          .catch((err) => {
            console.log(
              '(API call) Refreshing the token failed: ',
              err?.response?.data?.error
            );
          });
      } else {
        // Fetching current song failed and it wasn't because the access token expired
        console.log(
          '(API call) A different error in the getCurrentSong (not 401 when expired): ',
          err
        );
      }
    });
};

// A function that returns the artist string (for handling the case where there is no artist listed or when there is more than one artist)
const buildArtistString = (artistsArray) => {
  if (artistsArray?.length === 1) {
    // One artist
    return artistsArray?.[0]?.name;
  } else if (artistsArray?.length > 1) {
    // Multiple artists
    let multipleArtistsString = '';
    artistsArray?.forEach((artistObj, index) => {
      if (index === 0) {
        multipleArtistsString += `${artistObj?.name}`;
      } else {
        multipleArtistsString += `, ${artistObj?.name}`;
      }
    });
    return multipleArtistsString;
  } else {
    // No artist
    return 'Unknown artist';
  }
};

// A function that uses Google API to search YT for current song's video and returns the string
const getYoutubeIdJson = (title, artist, nodeRes) => {
  emote = randomEmote();
  // Decrese the remaining YT search quota
  ytSearchesLeft = ytSearchesLeft - 1;
  console.log(
    `(API call) Searching Youtube for "${title}" by "${artist}". We have ${ytSearchesLeft} searches left today.`
  );

  var service = google.youtube('v3');
  let ytSearchQuery = `${title} ${artist}`;
  service.search
    .list({
      part: 'snippet',
      q: ytSearchQuery,
      maxResults: 1,
      regionCode: 'DE',
      type: 'video',
      key: process.env.GOOGLE_KEY,
    })
    .then((res) => {
      if (res?.data?.items?.length > 0) {
        // We have found something on YT for this artist + title query so we will provide a YT link for this song to the user
        let videoId = res?.data?.items?.[0]?.id?.videoId;
        console.log(
          `(API call) A relevant Youtube video with an ID ${videoId} was found.`
        );
        currentSong.youtubeId = videoId;
        nodeRes.json({
          full: `${emote} "${title}" by "${artist}" - https://youtu.be/${videoId} ${emote}`,
          title: title,
          artist: artist,
          youtubeLink: `https://youtu.be/${videoId}`,
          emote: emote,
        });
      } else {
        // We haven't found anything so we will only provide the user with the songtitle and the artist
        console.log(
          '(API call) Youtube seach returned nothing. We will not provide a Youtube link to the user.'
        );
        currentSong.youtubeId = 'notfound';
        nodeRes.json({
          full: `${emote} "${title}" by "${artist}" ${emote}`,
          title: title,
          artist: artist,
          youtubeLink: '/',
          emote: emote,
        });
      }
    })
    .catch((err) => {
      // An error occured while searching YT so just provide the user with the song title and the artist
      console.log(err);
      console.log(
        '(API call) Youtube seach returned an error. We will not provide a Youtube link to the user.'
      );
      currentSong.youtubeId = 'notfound';
      nodeRes.json({
        full: `${emote} "${currentSong.title}" by "${currentSong.artist}" ${emote}`,
        title: title,
        artist: artist,
        youtubeLink: '/',
        emote: emote,
      });
    });
};

// Listen on /music for authorization attempts (/music is our redirect url in the Spotify app)
app.get('/music', function (req, res) {
  let code = req?.query?.code;
  if (code) {
    // There is a 'code' query param present which is required for the authorization so we will proceed with the authorization process
    getTokens(code, res);
  }
});

app.get(`/current_song/${process.env.TWITCH_CHANNEL}`, function (req, res) {
  getCurrentSongJson(res);
});
