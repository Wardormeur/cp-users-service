'use strict';

var _ = require('lodash');
var async = require('async');

module.exports = function (options) {
  var seneca = this;
  var plugin = 'test-user-data';
  var users = [
    { nick: 'admin@example.com', name: 'Admin', email: 'admin@example.com', password: 'test', roles: ['cdf-admin'], initUserType: { name: 'champion'}},
    { nick: 'manager@example.com', name: 'Manager', email: 'manager@example.com', password: 'test', roles: ['cdf-admin'], initUserType: {name:  'champion'}},
    { nick: 'mentor1@example.com', name: 'Mentor1', email: 'mentor1@example.com', password: 'testmentor1', roles: ['basic-user'], initUserType: {name: 'mentor'}},
    { nick: 'mentor2@example.com', name: 'Mentor2', email: 'mentor2@example.com', password: 'testmentor2', roles: ['basic-user'], initUserType: {name: 'mentor'}},
    { nick: 'champion1@example.com', name: 'Champion1', email: 'champion1@example.com', password: 'testchampion1', roles: ['basic-user'], initUserType: {name: 'champion'}},
    //parent w/o children
    { nick: 'parent1@example.com', name: 'Parent1', email: 'parent1@example.com', password: 'test', roles: ['basic-user'], initUserType: {name: 'parent-guardian'}},
    //parent w/ multiple children
    { nick: 'parent2@example.com', name: 'Parent2', email: 'parent2@example.com', password: 'test', roles: ['basic-user'], initUserType: {name: 'parent-guardian'}},
    // Second parent w/multiple children
    { nick: 'parent2-2@example.com', name: 'Parent2-2', email: 'parent2-2@example.com', password: 'test', roles: ['basic-user'], initUserType: {name: 'parent-guardian'}}

  ];

  var children = [
    //  u13 w/o password/email
    { nick: 'c1u13@example.com', name: 'c1u13', password: 'test', roles: ['basic-user'], initUserType: { name: 'attendee-u13'}},
    //  u13 with password/email
    { nick: 'c2u13@example.com', name: 'c2u13', email: 'c2u13@example.com', password: 'test', roles: ['basic-user'], initUserType: { name: 'attendee-u13'}},

    { nick: 'c1o13@example.com', name: 'c1o13', email: 'c1o13@example.com', password: 'test', roles: ['basic-user'], initUserType: { name: 'attendee-o13'}}
  ];


  seneca.add({ role: plugin, cmd: 'insert' }, function (args, done) {

    var userpin = seneca.pin({ role: 'user', cmd: '*' });

    var registerusers = function (done) {
      async.forEachOfSeries(users, function(user, index, cb){
        userpin.register(user, function(err, response){
          if (err) return done(err);
          if (response.ok === false) {
            console.error('insert failed: ', response);
            return cb(null, response);
          }
          users[index].id = response.user.id;
          var profileData = {
            name:     response.user.name,
            userId:   response.user.id,
            email:    response.user.email,
            userType: response.user.initUserType.name
          };
          seneca.act({role:'cd-profiles', cmd:'save', profile: profileData}, cb);
        });

      }, done);
    };

    var registerKids = function(done) {
      var parents = [_.last(users).id, users[users.length - 2].id];

      async.forEachOfSeries(children, function(user, index, cb){
        userpin.register(user, function(err, response){
          if (err) return done(err);
          if (response.ok === false) {
            console.error('insert failed: ', response);
            return cb(null, response);
          }
          children[index].id = response.user.id;

          var profileData = {
            alias:    response.user.nick,
            name:     response.user.name,
            userId:   response.user.id,
            email:    response.user.email,
            userType: response.user.initUserType.name,
            parents: parents
          };
          seneca.act({role:'cd-profiles', cmd:'save', profile: profileData}, function(err, childProfile) {
            if (err) return done(err);
            async.forEach(parents, function(parent, doneParent){
              seneca.act({role: 'cd-profiles', cmd: 'load_user_profile', userId: parent}, function(err, parentProfile) {
                if (err) return done(err);

                if(_.isEmpty(parentProfile.children)) parentProfile.children = [];
                parentProfile.children.push(childProfile);
                seneca.act({role:'cd-profiles', cmd:'save', profile: parentProfile}, doneParent);
              });
            }, cb)
          });
        });
      }, done);
    };

    async.series([
      registerusers,
      registerKids
    ], done);

  });

  seneca.add({ role: plugin, cmd: 'clean' }, function (args, done) {
    var userpin = seneca.pin({ role: 'user', cmd: '*' });

    var deleteusers = function (done) {
      async.eachSeries(users, userpin.delete, done);
    };

    async.series([
      deleteusers
    ], done);
  });

  return {
    name: plugin
  };
};
