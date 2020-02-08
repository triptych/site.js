//////////////////////////////////////////////////////////////////////
//
// Command: start
//
// Starts the Site.js daemon.
//
//////////////////////////////////////////////////////////////////////

const _start = require('../lib/start')
const ensure = require('../lib/ensure')
const Site = require('../../index')

function start () {
  ensure.systemctl()
  ensure.root('start')

  Site.logAppNameAndVersion(/* compact = */ true)

  try {
    // Start the web server.
    _start()
  } catch (error) {
    process.exit(1)
  }
}

module.exports = start
