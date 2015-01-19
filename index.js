var pull     = require('pull-stream')
var ssbmsgs  = require('ssb-msgs')
var multicb  = require('multicb')
var memview  = require('level-memview')
var pushable = require('pull-pushable')

exports.manifest    = require('./manifest')
exports.permissions = require('./permissions')

exports.init = function (sbot) {

  var api = {}
  var state = {
    // indexes
    posts: [],
    myposts: [], // reused by `postsByAuthor` for the local user
    postsByAuthor: {},
    inbox: [],
    adverts: [],

    // views
    profiles: {},
    trustedProfiles: {},
    names: {}, // ids -> names
    nameTrustRanks: {}, // ids -> trust-ranks
    ids: {}, // names -> ids
    threads: {} // maps: post key -> { replies: [{ts:,key:}], parent:, numThreadReplies: }
  }
  state.postsByAuthor[sbot.feed.id] = state.myposts // alias myposts inside postsByAuthor

  var processor = require('./processor')(sbot, state)
  var awaitSync = memview(sbot.ssb, processor, function () { return null })

  // track sync state
  var isSynced = false
  awaitSync(function () { isSynced = true })

  // events stream
  var eventsStream = pushable()
  processor.events.on('post', function (post) {
    if (isSynced)
      eventsStream.push({ type: 'post', post: post })
  })

  // getters

  api.events = function () {
    return eventsStream
  }

  api.getMyProfile = function (cb) {
    awaitSync(function () {
      api.getProfile(sbot.feed.id, cb)
    })
  }

  api.getThreadMeta = function (key, cb) {
    awaitSync(function () {
      cb(null, state.threads[key])
    })
  }
  api.getAllThreadMetas = function (cb) {
    awaitSync(function () {
      cb(null, state.threads)
    })
  }

  api.getMsg = function (key, cb) {
    awaitSync(function () {
      sbot.ssb.get(key, function (err, msg) {
        if (err) cb(err)
        else {
          var obj = { key: key, value: msg }
          if (state.threads[key]) {
            for (var k in state.threads[key])
              obj[k] = state.threads[key][k]
          }
          cb(null, obj)
        }
      })
    })
  }
  api.getReplies = function (key, cb) {
    awaitSync(function () {
      if (key in state.threads && state.threads[key].replies.length) {
        var done = multicb({ pluck: 1 })
        state.threads[key].replies.forEach(function (reply) { api.getMsg(reply.key, done()) })
        return done(cb)
      }
      cb(null, [])
    })
  }
  api.getPostParent = function (key, cb) {
    awaitSync(function () {
      if (key in state.threads && state.threads[key].parent)
        api.getMsg(state.threads[key].parent, cb)
      else
        cb(null, null)
    })
  }
  api.getThread = function (key, cb) {
    awaitSync(function () {
      var done = multicb()
      var thread = { key: key, value: null, replies: null, numThreadReplies: 0, parent: null }
      get(thread, done())

      function get(t, cb) {
        api.getMsg(t.key, function (err, msg) {
          if (err) return cb(err)
          t.value = msg.value
          cb(null, t)
        })
        replies(t)
      }

      function replies(t) {
        if (!state.threads[t.key])
          return
        t.parent = state.threads[t.key].parent
        t.numThreadReplies = state.threads[t.key].numThreadReplies
        t.replies = state.threads[t.key].replies.map(function (reply) {
          var rt = { key: reply.key, value: null, replies: null, numThreadReplies: 0, parent: null }
          get(rt, done())
          return rt
        })
      }

      done(function (err) {
        if (err) return cb(err)
        cb(null, thread)
      })
    })
  }

  api.getFeed = function (opts, cb) {
    awaitSync(function () {
      opts = opts || {}
      opts.keys = true
      opts.limit = opts.limit || 30

      // convert gt, gte, lt, lte so that you can do `getFeed({ gt: msg1, lt: msg2 })`
      opts.gt  = msgToFeedDBKey(opts.gt)
      opts.gte = msgToFeedDBKey(opts.gte)
      opts.lt  = msgToFeedDBKey(opts.lt)
      opts.lte = msgToFeedDBKey(opts.lte)

      pull(
        sbot.ssb.createFeedStream(opts),
        pull.collect(cb)
      )
    })
  }
  api.getPosts = listGetter(state.posts)
  api.getPostCount = function (cb) { 
    awaitSync(function () { cb(null, state.posts.length) })
  }
  api.getPostsBy = function (author, opts, cb) {
    listGetter(state.postsByAuthor[author] || [])(opts, cb)
  }
  api.getInbox = listGetter(state.inbox)
  api.getInboxCount = function (cb) { 
    awaitSync(function () { cb(null, state.inbox.length) })
  }
  api.getAdverts = listGetter(state.adverts)
  api.getAdvertCount = function (cb) { 
    awaitSync(function () { cb(null, state.adverts.length) })
  }
  api.getRandomAdverts = function (num, oldest, cb) {
    awaitSync(function () {
      var done = multicb({ pluck: 1 })
      for (var i = 0; i < num && i < state.adverts.length; i++) {
        var index = (Math.random()*Math.min(state.adverts.length, oldest))|0
        api.getMsg(state.adverts[index].key, done())
      }
      done(cb)
    })
  }

  api.getProfile = function (id, cb) {
    awaitSync(function () { cb(null, state.profiles[id]) })
  }
  api.getAllProfiles = function (cb) {
    awaitSync(function () { cb(null, state.profiles) })
  }
  api.getNamesById = function (cb) {
    awaitSync(function () { cb(null, state.names) })
  }
  api.getNameTrustRanks = function (cb) {
    awaitSync(function () { cb(null, state.nameTrustRanks) })
  }
  api.getName = function (id, cb) {
    awaitSync(function () { cb(null, state.names[id]) })
  }
  api.getIdsByName = function (cb) {
    awaitSync(function () { cb(null, state.ids) })
  }

  // helper to get an option off an opt function (avoids the `opt || {}` pattern)
  function o (opts, k, def) {
    return opts && opts[k] !== void 0 ? opts[k] : def
  }

  // helper to get messages from an index
  function listGetter (index) {
    return function (opts, cb) {
      awaitSync(function () {
        if (typeof opts == 'function') {
          cb = opts
          opts = null
        }
        var start = o(opts, 'start', 0)
        var end   = o(opts, 'end', start + 30)

        var done = multicb({ pluck: 1 })
        index
          .slice(start, end)
          .forEach(function (v) { api.getMsg(v.key, done()) })
        done(cb)
      })
    }
  }

  // helper to convert gt,gte,lt,lte params from messages into proper keys for the feeddb index
  function msgToFeedDBKey(v) {
    if (v && v.key && v.value)
      return [v.value.timestamp, v.value.author]
  }

  return api
}