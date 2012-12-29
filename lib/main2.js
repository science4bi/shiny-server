#!/usr/bin/env node

require('./core/log');
var path = require('path');
var url = require('url');
var util = require('util');
var shutdown = require('./core/shutdown');
var proxy_http = require('./proxy/http');
var proxy_sockjs = require('./proxy/sockjs');
var router = require('./router/router')
var config_router = require('./router/config-router');
var Server = require('./server/server');
var WorkerRegistry = require('./worker/worker-registry');

// A simple router function that does nothing but respond "OK". Can be used for
// load balancer health checks, for example.
function ping(req, res) {
  if (url.parse(req.url).pathname == '/ping') {
    res.writeHead(200, {'Content-Type': 'text/plain'});
    res.end('OK');
    return true;
  }
  return false;
}

// We'll need routers...
var indirectRouter = new router.IndirectRouter(new router.NullRouter());
var metarouter = router.join(indirectRouter, ping);

// ...a worker registry...
var workerRegistry = new WorkerRegistry();

// ...an HTTP proxy...
var shinyProxy = new proxy_http.ShinyProxy(
  metarouter,
  workerRegistry
);

// ...and a SockJS proxy.
var sockjsServer = proxy_sockjs.createServer(metarouter, workerRegistry);

// Now create a server and hook everything up.
var server = new Server();
server.on('request', shinyProxy.httpListener);
server.on('error', function(err) {
  logger.error('HTTP server error (' + err.listenKey + '): ' + err.message);
});
server.on('clientError', function(err) {
  logger.error('HTTP client error (' + err.listenKey + '): ' + err.message);
});
sockjsServer.installHandlers(server);

function loadConfig() {
  config_router.createRouter_p(path.normalize(path.join(__dirname, '../test/config/good.config')))
  .then(function(configRouter) {
    indirectRouter.setRouter(configRouter);
    server.setAddresses(configRouter.getAddresses());
  })
  .fail(function(err) {
    logger.error('Error loading config: ' + err.message);
  })
  .done();
}

loadConfig();

// On SIGHUP (i.e., initctl reload), reload configuration
process.on('SIGHUP', function() {
  logger.info('SIGHUP received, reloading configuration');
  loadConfig();
});

// On SIGUSR1, write worker registry contents to log
process.on('SIGUSR1', function() {
  workerRegistry.dump();
});

// Clean up worker processes on shutdown

var needsCleanup = true;
function gracefulShutdown() {
  // Sometimes the signal gets sent twice. No idea why.
  if (!needsCleanup)
    return;

  // On SIGINT/SIGTERM (i.e. normal termination) we wait a second before
  // exiting so the clients can all be notified
  shutdown.shuttingDown = true;
  try {
    server.destroy();
  } catch (err) {
    logger.error('Error while attempting to stop server: ' + err.message);
  }
  logger.info('Shutting down worker processes (with notification)');
  workerRegistry.shutdown();
  needsCleanup = false;
  setTimeout(process.exit, 1000);
}

function lastDitchShutdown() {
  if (!needsCleanup)
    return;
  // More-violent shutdown (e.g. uncaught exception), no chance to notify
  // workers as timers won't be scheduled
  shutdown.shuttingDown = true;
  logger.info('Shutting down worker processes');
  workerRegistry.shutdown();
}

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);
process.on('uncaughtException', function(err) {
  logger.error('Uncaught exception: ' + err);
  throw err;
  process.exit(1);
});
process.on('exit', lastDitchShutdown);