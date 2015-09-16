'use strict';
var async = require('async');
var _     = require('lodash');
var moment = require('moment');
var fs = require('fs');
var path = require('path');

function applyForEvent(args, callback) {
  var seneca = this;
  var plugin = args.role;
  var ENTITY_NS = 'cd/applications';
  var eventId = args.applyData.eventId;
  var user = args.applyData.user;
  var children = args.applyData.children;
  var emailSubject = args.applyData.emailSubject;
  var applications = [];
  var so = seneca.options();

  async.waterfall([
    buildApplications,
    sendApplications
  ], callback);

  function buildApplications(done) {
    if(children) {
      async.each(children, function (child, cb) {
        seneca.act({role: 'cd-users', cmd: 'load'}, {id: child}, function (err, response) {
          if(err) return cb(err);
          var childUser = response;
          //Query cd-profiles with user.id to apply permissions.
          seneca.act({role: 'cd-profiles', cmd: 'list', query:{userId:childUser.id}}, function (err, response) {
            if(err) return cb(err);
            var childProfile = response;
            var application = {
              eventId: eventId,
              parentId: user.id,
              userId: childUser.id,
              name: childUser.name,
              dateOfBirth: childProfile.dob,
              status: 'pending'
            };
            applications.push(application);
            cb();
          });
        });
      }, done);
    } else {
      seneca.act({role: 'cd-profiles', cmd: 'list', query:{userId:user.id}}, function (err, response) {
        if(err) return cb(err);
        var userProfile = response;
        var application = {
          eventId: eventId,
          userId: user.id,
          name: user.name,
          dateOfBirth: userProfile.dob,
          status: 'pending'
        };
        applications.push(application);
        done();
      });
    }
  }


  function sendApplications(done) {
    async.eachSeries(applications, function (application, cb) {
      async.waterfall([
        isMemberOfDojo,
        checkForApplication,
        applyForEvent,
        sendConfirmationEmail
      ], cb);

      function isMemberOfDojo(done) {
        var userId = application.parentId || application.userId; //Make sure that the parent is a member.

        seneca.act({role:plugin, cmd:'getEvent', id:eventId}, function (err, response) {
          if(err) return done(err);
          var dojoId = response.dojoId;
          seneca.act({role:'cd-dojos', cmd:'dojos_for_user', id:userId}, function (err, response) {
            if(err) return done(err);
            var dojos = response;
            var isMember = _.find(dojos, function (dojo) {
              return dojo.id === dojoId;
            });
            if(isMember) return done(null, {});
            return done(null, {error: 'User is not member of Dojo.'});
          });
        });

      }

      //Make sure this user has not already applied for this event
      function checkForApplication(status, done) {
        if(status.error) return done(null, status);
        var applicationsEntities = seneca.make$(ENTITY_NS);
        applicationsEntities.list$({userId:application.userId, eventId:eventId}, function (err, response) {
          if(err) return done(err);
          if(response.length > 0) {
            return done(null, {error: 'User has already applied for this event.'});
          }
          return done(null, {});
        });
      }

      function applyForEvent(status, done) {
        if(status.error) return done(null, status, {});
        if(application.parentId) delete application.parentId;
        var applicationsEntities = seneca.make$(ENTITY_NS);
        applicationsEntities.save$(application, function (err, response) {
          if(err) return done(err);
          return done(null, {}, response);
        });
      }

      function sendConfirmationEmail(status, application, done) {
        if(status.error) return done(null, status);
        seneca.act({role: plugin, cmd: 'getEvent', id:application.eventId}, function (err, response) {
          if(err) return done(err);
          var event = response;
          var payload;
          var eventTime = '';
          var locality = args.locality || 'en_US';

          if(event.dates.length > 1) {
            //Send email for recurring event
            var firstDate = _.first(event.dates).startTime;
            var lastDate = _.last(event.dates).startTime;
            var eventStartDate = moment.utc(firstDate).format('MMMM Do YYYY');
            var eventEndDate = moment.utc(lastDate).format('MMMM Do YYYY');
            eventTime = moment.utc(firstDate).format('HH:mm') + ' - ' + moment.utc(_.first(event.dates).endTime).format('HH:mm');
            //TODO: Translate weekdays.
            var weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
            var eventDay = weekdays[moment.utc(firstDate).weekday()];
            
            payload = {
              to:user.email,
              code: 'recurring-event-application-received-',
              locality: locality,
              subject: emailSubject,
              content:{
                userName: application.name, 
                eventName: event.name,
                eventStartDate: eventStartDate,
                eventEndDate: eventEndDate,
                eventDay: eventDay,
                eventTime: eventTime,
                year: moment.utc(new Date()).format('YYYY')
              }
            };
          } else {
            //Send email for one-off event
            var eventDate = moment.utc(_.first(event.dates).startTime).format('MMMM Do YYYY');
            eventTime = moment.utc(_.first(event.dates).startTime).format('HH:mm') + ' - ' + moment.utc(_.first(event.dates).endTime).format('HH:mm');
            
            payload = {
              to: user.email,
              code: 'one-off-event-application-received-',
              locality: locality,
              subject: emailSubject,
              content: {
                userName: application.name,
                eventName: event.name,
                eventDate: eventDate,
                eventTime: eventTime,
                year: moment.utc(new Date()).format('YYYY')
              }
            };
          }
         
          seneca.act({role:'cd-dojos', cmd:'send_email', payload:payload}, done);
        });
      }
    }, done);
  
  }
  
}

module.exports = applyForEvent;