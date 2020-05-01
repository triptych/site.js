//////////////////////////////////////////////////////////////////////
//
// Command: update
//
// Checks for updates and updates Site.js if new version is found.
//
//////////////////////////////////////////////////////////////////////

const https = require('https')
const os = require('os')
const fs = require('fs')
const path = require('path')
const { Readable } = require('stream')

const tar = require('tar-stream')
const gunzip = require('gunzip-maybe')
const concat = require('concat-stream')

const Site = require('../../index')
const ensure = require('../lib/ensure')
const status = require('../lib/status')
const restart = require('../lib/restart')

async function update () {
  const platform = os.platform()
  const cpuArchitecture = os.arch()
  const isLinux = platform === 'linux'

  const releaseType = Site.releaseType

  ensure.root('update')

  Site.logAppNameAndVersion(/* compact = */ true)

  console.log(` 🧐 Checking for ${releaseType} updates…\n`)

  let response
  try {
    response = await secureGet(`https://sitejs.org/version/${releaseType}`)
  } catch (error) {
    console.log(` 🤯 Error: Could not check for ${releaseType} updates.\n`)
    console.log(error)
    exitGracefully(1)
    return
  }

  const latestVersion = response.body
  const currentVersion = Site.binaryVersion

  const humanReadableCurrentVersion = Site.humanReadableBinaryVersion
  const humanReadableLatestVersion = Site.binaryVersionToHumanReadableDateString(latestVersion)

  if (currentVersion !== latestVersion) {
    // Are we running a newer version than the latest release version?
    if (currentVersion > latestVersion) {
      console.log(` 🤓 You are running a newer ${releaseType} version (released on ${humanReadableCurrentVersion}) than the latest ${releaseType} version (released on ${humanReadableLatestVersion}).\n`)
      exitGracefully()
      return
    }

    // Get the source version also.
    try {
      response = await secureGet(`https://sitejs.org/version/`)
    } catch (error) {
      console.log(` 🤯 Error: Could not check for ${releaseType} source version.\n`)
      console.log(error)
      exitGracefully(1)
      return
    }

    const latestSourceVersion  = response.body
    const currentSourceVersion = Site.sourceVersion

    const currentFullVersion = `${currentBinaryVersion}/${currentSourceVersion}`
    const latestFullVersion  = `${latestBinaryVersion}/${latestSourceVersion}`

    // The current version is not newer than the latest version and we know
    // that it isn’t equal to the release version so it must be older. Let’s
    // update!
    console.log(` 🎁 There is a new ${releaseType} version of Site.js available (${latestFullVersion} released on ${humanReadableLatestVersion}). You currently have ${releaseType} version ${currentFullVersion} released on ${humanReadableCurrentVersion}\n`)

    //
    // Compose the right binary URL for the platform and architecture.
    //

    let platformPath = {
      'linux': 'linux',
      'darwin': 'macos',
      'win32': 'windows'
    }[platform]

    if (platformPath === 'linux' && cpuArchitecture === 'arm') {
      platformPath = `${platformPath}-arm`
    }

    let binaryUrl = `https://sitejs.org/binaries/${releaseType}/${platformPath}/${latestVersion}.tar.gz`

    console.log(` 📡 Downloading Site.js ${releaseType} version ${latestFullVersion}…`)

    let latestReleaseResponse
    try {
      latestReleaseResponse = await secureGetBinary(binaryUrl)
    } catch (error) {
      console.log(' 🤯 Error: Could not download update.\n')
      console.log(error)
      exitGracefully(1)
      return
    }

    const latestRelease = latestReleaseResponse.body

    console.log(' 📦 Installing…')

    if (platform === 'win32') {
      // Windows cannot reference count (aww, bless), so, of course, we have
      // to do something special for it. In this case, while unlinking fails
      // with an EPERM error, we can rename the file and that works.
      const backupFilePath = path.join('C:', 'Program Files', 'site.js', 'old-site.exe')

      // If a backup file exists from the last time we did an update, mark
      // it for deletion.
      if (fs.existsSync(backupFilePath)) {
        fs.unlinkSync(backupFilePath)
      }

      // Rename the current version.
      fs.renameSync(binaryPath(), backupFilePath)
    } else {
      // On Linux-like systems, unlink the old file. This will succeed even if
      // the executable is currently running.
      fs.unlinkSync(binaryPath())
    }

    // Extract the latest release in memory from the gzipped tarball.
    await extract(latestRelease)

    // Check if the server daemon is running. If so, restart it so it uses
    // the latest version of Site.js.
    if (isLinux) {
      if (ensure.commandExists('systemctl')) {
        const { isActive } = status()
        if (isActive) {
          console.log(` 😈 Daemon is running on old version. Restarting it using Site.js ${releaseType} version ${latestFullVersion}…`)

          try {
            restart()
          } catch (error) {
            console.log(' 🤯 Error: Could not restart the Site.js daemon.\n')
            console.log(error)
            exitGracefully(1)
            return
          }
        }
      }
    }
    console.log(' 🎉 Done!\n')
  } else {
    console.log(' 😁👍 You’re running the latest version of Site.js!\n')
  }
  exitGracefully()
  return
}

module.exports = update

//
// Helpers.
//

// Note: since this does not exit immediately on Windows, follow all calls to this
// ===== function with a return as the expectation will be that execution of the
//       current function should stop immediately even if the exit is delayed.
function exitGracefully(code = 0) {
  if (os.platform() === 'win32') {
    // On Windows, a new window pops up with Administrator privileges. Wait a few seconds so the
    // person can see the output in it before it closes.
    process.stdout.write('This window will close in 3…')
    setTimeout(_=>{
      process.stdout.write(' 2…')
      setTimeout(_=>{
        process.stdout.write(' 1…')
        setTimeout(_=>{
          process.exit(code)
        }, 1000)
      }, 1000)
    }, 1000)
  } else {
    // All other proper operating systems may exit immediately.
    process.exit(code)
  }
}


function binaryPath () {
  return os.platform() === 'win32' ? path.join('C:', 'Program Files', 'site.js', 'site.exe') : '/usr/local/bin/site'
}


async function extract (release) {
  return new Promise((resolve, reject) => {
    const extractTar = tar.extract()

    extractTar.on('entry', (header, stream, next) => {
      // There should be only one file in the archive and it should either be called site (Linuxesque)
      // or site.exe (Windows).
      if (header.name === 'site' || header.name === 'site.exe') {
        stream.pipe(concat(executable => {
          fs.writeFileSync(binaryPath(), executable, { mode: 0o755 })
          resolve()
        }))
      } else {
        console.log(` 🤯 Error: Unknown file encountered: ${header.name}`)
        reject()
      }
    })

    bufferToStream(release).pipe(gunzip()).pipe(extractTar)
  })
}


async function secureGet (url) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, {timeout: 10 /* seconds */ * 1000}, response => {
      const code = response.statusCode

      if (code !== 200) {
        reject({code})
      }

      let body = ''
      response.on('data', _ => body += _)
      response.on('end', () => {
        resolve({code, body})
      })
    })

    request.on('timeout', () => {
      request.abort()
    })

    request.on('error', (error) => {
      if (error.code === "ECONNRESET") {
        console.log(' 😱 Connection timed out while attempting to check for updates.')
        reject()
        return
      } else if (error.code === 'ECONNREFUSED') {
        console.log(` 😱 Connection was refused. Site might be down. ${error}`)
        reject()
      } else {
        // Catch-all. Just display the error.
        console.log(` 🤯 ${error}`)
        reject()
      }
    })
  })
}


async function secureGetBinary (url) {
  return new Promise((resolve, reject) => {
    https.get(url, (response) => {
      const code = response.statusCode

      if (code !== 200) {
        reject({code})
      }

      let chunks = []
      response.on('data', _ => chunks.push(_))
      response.on('end', () => {
        const body = Buffer.concat(chunks)
        resolve({code, body})
      })
    })
  })
}


// Takes a binary buffer and returns a Readable instance stream.
// Courtesy: https://stackoverflow.com/a/54136803
 function bufferToStream(binary) {
  const readableInstanceStream = new Readable({
    read() {
      this.push(binary)
      this.push(null)
    }
  })

  return readableInstanceStream
}
