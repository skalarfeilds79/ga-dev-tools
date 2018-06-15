// Copyright 2016 Google Inc. All rights reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.


/* global gapi */


import once from 'lodash/once'

import {loadScript, encodeQuery} from './utils';


const bitly_client_id_promise = new Promise((resolve, reject) => {
  const key = window.BITLY_CLIENT_ID
  if(key) {
    resolve(key)
  } else {
    reject(new Error("No BITLY_CLIENT_ID found! Need to attach it to window as a global"))
  }
})


const urlMapCache = new Map();

// Use a global object to distinguish forbidden errors from other errors
const forbiddenError = new Error("Forbidden")

/**
 * Accepts a long URL and returns a promise that is resolved with its shortened
 * version. This function loads the urlshortener API if it's not loaded, but
 * the library is only ever loaded once. Long URLs are also cached, so multiple
 * requests for the same URL are never made.
 * @param {string} longUrl
 * @return {Promise} A promise resolved with the shortend URL.
 */
export async function shortenUrl(longUrl) {
  // First, see if it's cached.
  const cachedUrl = urlMapCache.get(longUrl)
  if(cachedUrl != undefined)
    return cachedUrl

  const bitly_api_token = localStorage.getItem("BITLY_API_TOKEN")

  // Attempt the API call with the stored token, but be ready to get a new
  // token and retry if it fails.
  if(bitly_api_token != undefined) {
    try {
      return await createBitlink({
        longUrl: longUrl,
        token: bitly_api_token,
        checkForbidden: true
      })
    } catch(e) {
      // If it wasn't a forbidden error, return it to the caller. Otherwise,
      // it's possible we have a bad token and should retry with a fresh one.
      if(e !== forbiddenError)
        throw

      // Hmm. I guess the token was bad. Clear the saved one before proceeding.
      localStorage.removeItem("BITLY_API_TOKEN")
    }
  }

  // Okay, so we have no token. Send the user to the bitly oauth url.

  // This client ID should be attached as a global by the server template
  // renderer. This way we don't have to make a whole round trip to an API to
  // get it.
  const bitly_client_id = window.BITLY_CLIENT_ID
  if(!bitly_client_id)
    throw new Error("No OAuth client ID available. Make sure to attach it as a global in the server!")

  // All the work happens on the auth site + callback
  const {token, error} = await spawnWindow(
    "https://Bitly.com/oauth/authorize" + encodeQuery({
      client_id: bitly_client_id,
      redirect_uri: "SOMEWHERE"
    })
  )

  if(error)
    throw new Error(error)

  // We have a token! Save it to localStorage, then retry the API call. At this
  // point, all errors should just be sent to the client; we've done all we can
  // to make it successful

  localStorage.setItem("BITLY_API_TOKEN", token)

  return await createBitlink({
    longUrl: longUrl,
    token: token,
    checkForbidden: false,
  })
}

// Like addEventListener, but returns a function to clear the listener. Makes
// it more amenable to inline arrow functions.
const addClearableListener = (target, event, listener) => {
  target.addEventListener(event, listener)
  return () => target.removeEventListener(event, listener)
}


/**
 * Create a promise that cleans up after itself. This is the same as a regular
 * promise, but the executor function is passed an additonal function called
 * cleanup. Cleanup can be called to add cleanup handlers to the promise.
 * When the promise is fullfilled in any way, all the cleanup handlers are
 * called in an unspecified order. Return values are ignored, but exceptions
 * or rejected promises are propogated outwards.
 *
 * @param  {Function(resolve, reject, cleanup)} executor An executor function,
 *   similar to what would be passed to new Promise(). It is given a third
 *   argument, cleanup, which it may call 0 or more times to add cleanup
 *   functions. These cleanup functions are all executed before the promise
 *   resolves.
 * @return {Promise} A new Promise. Will run to completion, and additionally
 *   run (and resolve) all cleanup handlers before resolving itself.
 */
const cleanupingPromise = executor => {
  const cleanups = []
  let addCleanup = cleaner => { cleanups.push(cleaner) }

  const promise = new Promise((resolve, reject) =>
    executor(resolve, reject, cleaner => { addCleanup(cleaner) })
  )

  addCleanup = () => { throw new Error("Can't add new cleanup handlers asynchronously")}

  const cleanupPromise = Promise.all(
    cleanups.map(cleanup => promise.finally(cleanup))
  )

  return promise.finally(() => cleanupPromise)
}
// TODO(nathanwest): replace this noise with a bluebird disposer

// Spawn a window and wait for a message from it. Reject if the window is closed
// with no message.
const spawnWindow = (url, features) => cleanupingPromise((resolve, reject, cleanup) => {
  // Await a message
  cleanup(addClearableListener(window, 'message', event => {
    if(event.origin === window.location.origin && event.source === childWindow)
      resolve(event.data)
  }))

  const childWindow = window.open(url, "_blank", features)
  if(childWindow == null)
    throw new Error(`Failed to open '${url}' in a new window`)
  cleanup(() => childWindow.close())

  const intervalHandle = window.setInterval(() => {
    if(window.closed)
      reject(new Error("Window was closed before sending a message"))
  }, 1000)
  cleanup(() => window.clearInterval(intervalHandle))
})

/**
 * Attempt to create a short URL by POSTing to the bitly API
 *
 * TODO(nathanwest): If we're rate limited, either hold off, or report an
 * error to the user.
 */
const createBitlink = async ({longUrl, token, checkForbidden=false}) => {
  const response = await fetch(
    "https://api-ssl.bitly.com/v4/shorten", {
      body: JSON.stringify({ long_url: longUrl }),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': `bearer ${token}`,
      }
    },
  )

  if(checkForbidden && response.status === 403)
    throw forbiddenError

  const body = await response.json()

  if(!response.ok)
    throw new Error(`Error ${response.status} from bitly: ${body.message}`)

  // While we're here, go ahead and cache it
  const link = body.link
  urlMapCache.set(longUrl, link)
  return link
}
