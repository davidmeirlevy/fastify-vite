const { resolve } = require('path')
const { createServer } = require('vite')
const middie = require('middie')
const fastifyPlugin = require('fastify-plugin')
const fastifyStatic = require('fastify-plugin')

const { build } = require('./build')
const { processOptions } = require('./options')

async function fastifyVite (fastify, options) {
  // Run options through Vite to get all Vite defaults taking vite.config.js
  // into account and ensuring options.root and options.vite.root are the same
  try {
    options = await processOptions(options)
  } catch (err) {
    console.error(err)
    process.exit(1)
  }

  // Provided by the chosen rendering adapter
  const { getHandler, getRenderGetter } = options.renderer

  // We'll want access to this later
  let handler
  let vite

  // Setup appropriate Vite route handler
  if (options.dev) {
    // For dev you get more detailed logging and hot reload
    vite = await createServer({
      server: { middlewareMode: true },
      ...options.vite
    })
    await fastify.register(middie)
    fastify.use(vite.middlewares)
    const getRender = getRenderGetter(options)
    handler = getHandler(options, getRender, vite)
  } else {
    // For production you get the distribution version of the render function
    const { assetsDir } = options.vite.build
    // We also register fastify-static to serve all static files in production (dev server takes of this)
    // Note: this is just to ensure it works, for a real world production deployment, you'll want
    // to capture those paths in Nginx or just serve them from a CDN instead
    // TODO make it possible to serve static assets from CDN
    await fastify.register(fastifyStatic, {
      root: resolve(options.distDir, `client/${assetsDir}`),
      prefix: `/${assetsDir}`
    })
    const getRender = getRenderGetter(options)
    handler = getHandler(options, getRender)
  }

  // Sets fastify.vite.get() helper which uses
  // a wrapper for setting a route with a data() handler
  fastify.decorate('vite', {
    handler,
    options,
    global: undefined,
    devServer: vite,
    get (url, { data, ...routeOptions } = {}) {
      return this.route(url, { data, method: 'GET', ...routeOptions })
    },
    post (url, { data, method, ...routeOptions } = {}) {
      return this.route(url, { data, method: 'GET', ...routeOptions })
    },
    route (url, { data, method, ...routeOptions } = {}) {
      let preHandler
      if (data) {
        preHandler = async function (req, reply) {
          req[options.hydration.data] = await data.call(this, req, reply)
        }
      }
      fastify.get(`/-/data${url}`, async function (req, reply) {
        return data.call(this, req, reply)
      })
      fastify.route({
        method,
        url,
        preHandler,
        handler,
        ...routeOptions
      })
    }
  })
  fastify.addHook('onReady', () => {
    // Pre-initialize request decorator for better performance
    // This actually safely adds things to Request.prototype
    fastify.decorateRequest(options.hydration.global, { getter: () => fastify.vite.global })
    fastify.decorateRequest(options.hydration.data, null)
    if (options.api) {
      fastify.decorateRequest('api', fastify.api)
    }
  })
}

fastifyVite.app = async function appExport (main, serve) {
  const fastify = await main()
  if (process.argv.length > 2 && process.argv[2] === 'build') {
    build(fastify.vite.options)
  } else {
    serve(fastify)
  }
}

module.exports = fastifyPlugin(fastifyVite)