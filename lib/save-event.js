'use strict';

var async = require('async');
var _ = require('lodash');
var moment = require('moment');
var shortid = require('shortid');

function saveEvent (args, callback) {
  var seneca = this;
  var ENTITY_NS = 'cd/events';

  var eventInfo = args.eventInfo;
  var plugin = args.role;
  var locality = args.locality || 'en_US';
  var user = args.user;
  var emailSubject;

  async.waterfall([
    saveEvent,
    saveSessions
  ], function (err, res) {
    if(err) return callback(null, {ok: false, why: err.message});
    return callback(null, res);
  });

  function saveEvent(done) {
    if(eventInfo.sessions && eventInfo.sessions.length > 20) return callback(new Error('You can only create a max of 20 sessions/rooms'));
    var maxTicketTypesExceeded = _.find(eventInfo.sessions, function (session) {
      return session.tickets.length > 20;
    });
    if(maxTicketTypesExceeded) return callback(new Error('You can only create a max of 20 ticket types'));

    var newEvent = {
      address: eventInfo.address,
      city: eventInfo.city,
      country: eventInfo.country,
      createdAt: new Date(),
      createdBy: eventInfo.userId,
      description: eventInfo.description,
      dojoId: eventInfo.dojoId,
      name: eventInfo.name,
      position: eventInfo.position,
      public: eventInfo.public,
      status: eventInfo.status,
      type: eventInfo.type,
      recurringType: eventInfo.recurringType,
      ticketApproval: eventInfo.ticketApproval
    };

    if (eventInfo.id) { // Check if this is an update.
      newEvent.id = eventInfo.id;
    }

    if (!eventInfo.dates || !Array.isArray(eventInfo.dates)) {
      var err = new Error('Dates must be specified');
      return done(err);
    }

    var pastDateFound = _.find(eventInfo.dates, function (date) {
      var utcOffset = moment().utcOffset();
      return moment.utc(date.startTime).subtract(utcOffset, 'minutes').diff(moment.utc(), 'minutes') < 0;
    });

    if(pastDateFound && !eventInfo.id) return done(new Error('Past events cannot be created'));

    newEvent.dates = eventInfo.dates;

    if(eventInfo.emailSubject){
      emailSubject = eventInfo.emailSubject;
      delete eventInfo.emailSubject;
    }

    var eventEntity = seneca.make$(ENTITY_NS);
    eventEntity.save$(newEvent, done);
  }


  function saveSessions(event, done) {
    if(_.isEmpty(eventInfo.sessions)) return setImmediate(function () { 
      return done(null, event); 
    });
    function removeDeletedSessions (done) {
      seneca.act({role: plugin, cmd: 'searchSessions', query: {eventId: event.id}}, function (err, existingSessions) {
        if(err) return done(err);
        async.each(existingSessions, function (existingSession, cb) {
          var sessionFound = _.find(eventInfo.sessions, function (session) {
            return existingSession.id === session.id;
          });
          if(!sessionFound) {
            return seneca.act({role: plugin, cmd: 'cancelSession', session: existingSession, locality: locality, user: user}, cb);
          } else {
            return cb();
          }
        }, done);
      });
    }

    function saveNewSessions (done) {
      async.each(eventInfo.sessions, function (session, cb) {
        session.eventId = event.id;
        if(event.status === 'cancelled') {
          session.emailSubject = emailSubject;
          seneca.act({role: plugin, cmd: 'cancelSession', session: session, locality: locality, user: user}, cb);
        } else {
          session.eventId = event.id;
          session.status = 'active';
          seneca.act({role: plugin, cmd: 'saveSession', session: session}, cb);
        }
      }, done);
    }

    async.series([
      removeDeletedSessions,
      saveNewSessions
    ], function (err) {
      if(err) return done(err);
      return done(null, event);
    });
  }

}

module.exports = saveEvent;