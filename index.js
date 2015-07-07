var pull     = require('pull-stream')
var multicb  = require('multicb')
var pl       = require('pull-level')
var pushable = require('pull-pushable')
var paramap  = require('pull-paramap')
var cat      = require('pull-cat')
var Notify   = require('pull-notify')
var ref      = require('ssb-ref')
var u        = require('./util')

exports.name        = 'phoenix'
exports.version     = '1.0.0'
exports.manifest    = require('./manifest')
exports.permissions = require('./permissions')

exports.init = function (sbot) {

  var api = {}
  var phoenixdb = sbot.ssb.sublevel('phoenix')
  var db = {
    isread: phoenixdb.sublevel('isread'),
    subscribed: phoenixdb.sublevel('subscribed')
  }
  var state = {
    // indexes (lists of {key:, ts:})
    mymsgs: [],
    home: u.index(), // also has `.isread`
    inbox: u.index(), // also has `.isread`
    votes: u.index(), // also has `.isread`, `.vote`, and `.votemsg`
    follows: u.index(), // also has `.isread` and `.following`

    // views
    profiles: {},
    names: {}, // ids -> names
    ids: {}, // names -> ids
    actionItems: {}
  }

  var processor = require('./processor')(sbot, db, state, emit)
  pull(pl.read(sbot.ssb.sublevel('log'), { live: true, onSync: onPrehistorySync }), pull.drain(processor))

  // track sync state
  // - processor does async processing for each message that comes in
  // - awaitSync() waits for that processing to finish
  // - pinc() on message arrival, pdec() on message processed
  // - nP === 0 => all messages processed
  var nP = 0, syncCbs = []
  function awaitSync (cb) {
    if (nP > 0)
      syncCbs.push(cb)
    else cb()
  }
  state.pinc = function () { nP++ }
  state.pdec = function () {
    nP--
    if (nP === 0) {
      syncCbs.forEach(function (cb) { cb() })
      syncCbs.length = 0
    }
  }

  var isPreHistorySynced = false // track so we dont emit events for old messages
  // grab for history sync
  state.pinc()
  function onPrehistorySync () {
    // when all current items finish, consider prehistory synced (and start emitting)
    awaitSync(function () { isPreHistorySynced = true })
    // release
    state.pdec()
  }

  // events stream
  var notify = Notify()
  function emit (type) {
    if (!isPreHistorySynced)
      return
    notify({ type: type })
  }

  // getters

  api.createEventStream = function () {
    return notify.listen()
  }

  api.getMyProfile = function (cb) {
    awaitSync(function () {
      api.getProfile(sbot.feed.id, cb)
    })
  }

  api.getIndexCounts = function (cb) {
    awaitSync(function () {
      cb(null, {
        inbox: state.inbox.rows.length,
        inboxUnread: state.inbox.filter(function (row) { return !row.isread }).length,
        upvotes: state.votes.filter(function (row) { return row.vote > 0 }).length,
        upvotesUnread: state.votes.filter(function (row) { return row.vote > 0 && !row.isread }).length,
        follows: state.follows.filter(function (row) { return row.following }).length,
        followsUnread: state.follows.filter(function (row) { return row.following && !row.isread }).length,
        home: state.home.rows.length
      })
    })
  }

  api.createInboxStream = indexStreamFn(state.inbox)
  api.createVoteStream = indexStreamFn(state.votes, function (row) { 
    if (row.vote <= 0) return false
    return row.votemsg
  })
  api.createFollowStream = indexStreamFn(state.follows, function (row) { 
    if (!row.following) return false
    return row.followmsg
  })
  api.createHomeStream = indexStreamFn(state.home)

  function indexMarkRead (indexname, key, keyname) {
    if (Array.isArray(key)) {
      key.forEach(function (k) {
        indexMarkRead(indexname, k, keyname)
      })
      return
    }

    var index = state[indexname]
    var row = index.find(key, keyname)
    if (row) {
      if (!row.isread)
        emit(indexname+'-remove')
      row.isread = true
    }
  }

  function indexMarkUnread (indexname, key, keyname) {
    if (Array.isArray(key)) {
      key.forEach(function (k) {
        indexMarkUnread(indexname, k, keyname)
      })
      return
    }

    var index = state[indexname]
    var row = index.find(key, keyname)
    if (row) {
      if (row.isread)
        emit(indexname+'-add')
      row.isread = false
    }
  }

  api.markRead = function (key, cb) {
    indexMarkRead('inbox', key)
    indexMarkRead('votes', key, 'votemsg')
    indexMarkRead('follows', key, 'followmsg')
    if (Array.isArray(key))
      db.isread.batch(key.map(function (k) { return { type: 'put', key: k, value: 1 }}), cb)
    else
      db.isread.put(key, 1, cb)
  }
  api.markUnread = function (key, cb) {
    indexMarkUnread('inbox', key)
    indexMarkUnread('votes', key, 'votemsg')
    indexMarkUnread('follows', key, 'followmsg')
    if (Array.isArray(key))
      db.isread.batch(key.map(function (k) { return { type: 'del', key: k }}), cb)
    else
      db.isread.del(key, cb) 
  }
  api.toggleRead = function (key, cb) {
    api.isRead(key, function (err, v) {
      if (!v) {
        api.markRead(key, function (err) {
          cb(err, true)
        })
      } else {
        api.markUnread(key, function (err) {
          cb(err, false)
        })
      }
    })
  }
  api.isRead = function (key, cb) {
    if (Array.isArray(key)) {
      var done = multicb({ pluck: 1 })
      key.forEach(function (k, i) {
        var cb = done()
        db.isread.get(k, function (err, v) { cb(null, !!v) })
      })
      done(cb)
    } else {
      db.isread.get(key, function (err, v) {
        cb && cb(null, !!v)
      })
    }
  }
 
  api.subscribe = function (key, cb) {
    db.subscribed.put(key, 1, cb)
  }
  api.unsubscribe = function (key, cb) {
    db.subscribed.del(key, cb) 
  }
  api.toggleSubscribed = function (key, cb) {
    api.isSubscribed(key, function (err, v) {
      if (!v) {
        api.subscribe(key, function (err) {
          cb(err, true)
        })
      } else {
        api.unsubscribe(key, function (err) {
          cb(err, false)
        })
      }
    })
  }
  api.isSubscribed = function (key, cb) {
    db.subscribed.get(key, function (err, v) {
      cb && cb(null, !!v)
    })
  }

  var lookupcodeRegex = /([a-z0-9\/\+\=]+\.[a-z0-9]+)(?:\[via\])?(.+)?/i
  api.useLookupCode = function (code) {
    var eventPush = pushable()

    // parse and validate the code
    var id, addrs
    var parts = lookupcodeRegex.exec(code)
    var valid = true
    if (parts) {
      id  = parts[1]
      addrs = (parts[2]) ? parts[2].split(',') : []

      // validate id
      if (!ref.isFeedId(id))
        valid = false

      // parse addresses
      addrs = addrs
        .map(function (addr) {
          addr = addr.split(':')
          if (addr.length === 3)
            return { host: addr[0], port: +addr[1], key: addr[2] }
        })
        .filter(Boolean)
    } else
      valid = false

    if (!valid) {
      eventPush.push({ type: 'error', message: 'Invalid lookup code' })
      eventPush.end()
      return eventPush
    }

    // begin the search!
    search(addrs.concat(sbot.gossip.peers()))
    function search (peers) {
      var peer = peers.pop()
      if (!peer)
        return eventPush.end()

      // connect to the peer
      eventPush.push({ type: 'connecting', addr: peer })      
      sbot.connect(peer, function (err, rpc) {
        if (err) {
          eventPush.push({ type: 'error', message: 'Failed to connect', err: err })
          return search(peers)
        }
        // try a sync
        sync(rpc, function (err, seq) { 
          if (seq > 0) {
            // success!
            eventPush.push({ type: 'finished', seq: seq })
            eventPush.end()
          } else
            search(peers) // try next
        })
      })
    }

    function sync (rpc, cb) {
      // fetch the feed
      var seq
      eventPush.push({ type: 'syncing', id: id })
      pull(
        rpc.createHistoryStream({ id: id, keys: false }),
        pull.through(function (msg) {
          seq = msg.sequence
        }),
        sbot.ssb.createWriteStream(function (err) {
          cb(err, seq)
        })
      )
    }

    return eventPush
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
  api.getName = function (id, cb) {
    awaitSync(function () { cb(null, state.names[id]) })
  }
  api.getIdsByName = function (cb) {
    awaitSync(function () { cb(null, state.ids) })
  }
  api.getActionItems = function (cb) {
    awaitSync(function () { cb(null, state.actionItems) })
  }

  // helper to get an option off an opt function (avoids the `opt || {}` pattern)
  function o (opts, k, def) {
    return opts && opts[k] !== void 0 ? opts[k] : def
  }

  // helper to get messages from an index
  function indexStreamFn (index, getkey) {
    return function (opts) {
      // emulate the `ssb.createFeedStream` interface
      var lt    = o(opts, 'lt')
      var lte   = o(opts, 'lte')
      var gt    = o(opts, 'gt')
      var gte   = o(opts, 'gte')
      var limit = o(opts, 'limit')

      // lt, lte, gt, gte should look like:
      // [msg.value.timestamp, msg.value.author]

      // helper to create emittable rows
      function lookup (row) {
        if (!row) return
        var key = (getkey) ? getkey(row) : row.key
        if (key) {
          var rowcopy = { key: key }
          for (var k in row) { // copy index attrs into rowcopy
            if (!rowcopy[k]) rowcopy[k] = row[k]
          }
          return rowcopy
        }
      }

      // helper to fetch rows
      function fetch (row, cb) {
        sbot.ssb.get(row.key, function (err, value) {
          // if (err) {
            // suppress this error
            // the message isnt in the local cache (yet)
            // but it got into the index, likely due to a link
            // instead of an error, we'll put a null there to indicate the gap
          // }
          row.value = value
          cb(null, row)
        })
      }

      // readstream
      var readPush = pushable()
      var read = pull(readPush, paramap(fetch))

      // await sync, then emit the reads
      awaitSync(function () {
        var added = 0
        for (var i=0; i < index.rows.length; i++) {
          var row = index.rows[i]

          if (limit && added >= limit)
            break

          // we're going to only look at timestamp, because that's all that phoenix cares about
          var invalid = !!(
            (lt  && row.ts >= lt[0]) ||
            (lte && row.ts > lte[0]) ||
            (gt  && row.ts <= gt[0]) ||
            (gte && row.ts < gte[0])
          )
          if (invalid)
            continue

          var r = lookup(row)
          if (r) {
            readPush.push(r)
            added++
          }
        }
        readPush.end()
      })

      if (opts.live) {
        // live stream, concat the live-emitter on the end
        index.on('add', onadd)
        var livePush = pushable(function () { index.removeListener('add', onadd) })
        function onadd (row) { livePush.push(lookup(row)) }
        var live = pull(livePush, paramap(fetch))
        return cat([read, live])
      }
      return read
    }
  }

  return api
}