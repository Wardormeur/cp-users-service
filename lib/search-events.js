'use strict';

var _ = require('lodash');
var moment = require('moment');

function searchEvents(args, callback) {
  var seneca = this;
  var eventsEntity = seneca.make$('cd/events');
  var query = args.query || {};
  var filterPastEvents = query.filterPastEvents || false;
  delete query.filterPastEvents;
  var events = [];
  var utcOffset = moment().utcOffset();
  
  eventsEntity.list$(query, function (err, response) {
    if(err) return callback(err);
    if(filterPastEvents) {
      _.each(response, function (event) {
        if(event.type === 'recurring'){
          var dateOfLastEventRecurrence = _.last(event.dates).startTime;
          if(moment.utc(dateOfLastEventRecurrence).subtract(utcOffset, 'minutes').diff(moment.utc(), 'minutes') > 0) {
            events.push(event);
          }
        } else {
          var oneOffEventDate = _.first(event.dates).startTime;
          if(moment.utc(oneOffEventDate).subtract(utcOffset, 'minutes').diff(moment.utc(), 'minutes') > 0){
            events.push(event);
          }
        }
      });
    } else {
      events = response;
    }

    return callback(null, events);
  });
}

module.exports = searchEvents;