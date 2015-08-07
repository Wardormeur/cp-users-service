'use strict';

var pg = require('pg');
var LargeObjectManager = require('pg-large-object').LargeObjectManager;
var shortid = require('shortid');
var moment = require('moment');

module.exports = function(options) {
  var seneca = this;

  var PARENT_GUARDIAN_PROFILE_ENTITY = 'cd/profiles';
  var plugin = 'cd-profiles';
  var _ = require('lodash');
  var async = require('async');
  var uuid = require('node-uuid');
  var hiddenFields = require('./data/hidden-fields.js');
  var fs = require('fs');
  var path = require('path');
  var so = seneca.options(); 

  var mentorPublicFields = [
    'name',
    'languagesSpoken',
    'programmingLanguages',
    'linkedin',
    'twitter',
    'userTypes',
    'dojos',
    'badges',
    'optionalHiddenFields'
  ];

  var championPublicFields = [
    'name',
    'languagesSpoken',
    'programmingLanguages',
    'linkedin',
    'twitter',
    'userTypes',
    'projects',
    'notes',
    'dojos',
    'optionalHiddenFields'
  ];

  var attendeeO13PublicFields = [
    'alias',
    'linkedin',
    'twitter',
    'badges',
    'userTypes',
    'optionalHiddenFields'
  ];

  var fieldWhiteList = {
    'mentor': mentorPublicFields,
    'champion': championPublicFields,
    'attendee-o13': attendeeO13PublicFields
  };

  ///var allowedOptionalFieldsYouth = ['dojos', 'linkedin', 'twitter', 'badges'];
  var allowedOptionalFieldsYouth = _.filter(hiddenFields, function(field){
    if(_.contains(field.allowedUserTypes, 'attendee-o13')) return field.modelName;
  });

  //var allowedOptionalFieldsChampion = ['notes', 'projects'];
  var allowedOptionalFieldsChampion = _.map(hiddenFields, function(field){
    if(_.contains(field.allowedUserTypes, 'champion')) return field.modelName;
  });

  var allowedOptionalFieldsMentor = _.map(hiddenFields, function (field) {
    if(_.contains(field.allowedUserTypes, 'mentor')) return field.modelName;
  });

  var allowedOptionalFields = {
    'champion': allowedOptionalFieldsChampion,
    'attendee-o13': allowedOptionalFieldsYouth,
    'mentor': allowedOptionalFieldsMentor
  };

  var immutableFields = ['email', 'userType', 'avatar'];

  var youthBlackList = ['name'];

  var requiredProfileFields = ['name', 'alias', 'dob', 'country', 'place', 'address'];

  //var userTypes = ['champion', 'mentor', 'parent-guardian', 'attendee-o13', 'attendee-u13'];
  //var userTypes = ['attendee-u13', 'attendee-o13', 'parent-guardian', 'mentor', 'champion'];


  seneca.add({role: plugin, cmd: 'create'}, cmd_create);
  seneca.add({role: plugin, cmd: 'list'}, cmd_list);
  seneca.add({role: plugin, cmd: 'load'}, cmd_load);
  seneca.add({role: plugin, cmd: 'save-youth-profile'}, cmd_save_youth_profile);
  seneca.add({role: plugin, cmd: 'save'}, cmd_save);
  seneca.add({role: plugin, cmd: 'update-youth-profile'}, cmd_update_youth);
  seneca.add({role: plugin, cmd: 'invite-parent-guardian'}, cmd_invite_parent_guardian);
  seneca.add({role: plugin, cmd: 'search'}, cmd_search);
  seneca.add({role: plugin, cmd: 'accept-invite'}, cmd_accept_invite);
  seneca.add({role: plugin, cmd: 'load_hidden_fields'}, cmd_load_hidden_fields);
  seneca.add({role: plugin, cmd: 'list_query'}, cmd_list_query);
  seneca.add({role: plugin, cmd: 'change_avatar'}, cmd_change_avatar);
  seneca.add({role: plugin, cmd: 'get_avatar'}, cmd_get_avatar);
  seneca.add({role: plugin, cmd: 'load_parents_for_user'}, cmd_load_parents_for_user);
  seneca.add({role: plugin, cmd: 'invite_ninja'}, cmd_invite_ninja);
  seneca.add({role: plugin, cmd: 'approve_invite_ninja'}, cmd_approve_invite_ninja);


  function cmd_search(args, done){
    if(!args.query){
      return done(new Error('Empty query'));
    }

    seneca.make$(PARENT_GUARDIAN_PROFILE_ENTITY).list$(args.query, done);
  }

  function cmd_create(args, done){
    var profile = args.profile;
   
    var profileKeys = _.keys(profile);
    var missingKeys = _.difference(requiredProfileFields, profileKeys);
    if(_.isEmpty(missingKeys)) profile.requiredFieldsComplete = true;

    if(args.user !== profile.userId) return done(null, new Error('Profiles can only be saved by the profile user.'));

    if(profile.id){
      profile = _.omit(profile, immutableFields);
    }

    seneca.make$(PARENT_GUARDIAN_PROFILE_ENTITY).save$(profile, function(err, profile){
      if(err){
        return done(err);
      }

      var forum_profile = _.clone(profile);
      forum_profile.username = forum_profile.name;
      seneca.act({role:'cd-nodebb-api', cmd:'update', user: forum_profile}, function(err, res){
        if (res.error) seneca.log.error('NodeBB Profile Sync Error: ', res.error);

        var query = {userId: profile.userId};
        seneca.act({role: 'cd-profiles', cmd: 'list', query: query, user: args.user}, done);
      });
    });
  }

  //TODO: clean up with async

  function cmd_save_youth_profile(args, done){
    var profile = args.profile;
    profile.parents = [];
    profile.parents.push(args.user);

    if(profile.id){
      profile = _.omit(profile, immutableFields);
    }

    var initUserType =  profile.userTypes[0];
    var password = profile.password;

    var nick = profile.alias || profile.name;
    
    var user = {
      name: profile.name,
      nick: nick,
      email: profile.email,
      initUserType: {name : initUserType},
      password: password,
      roles: ['basic-user']
    };
    
    function registerUser(youth, done) {

      if(youth) {
        delete user.email;
        delete user.password;
      }

      seneca.act({role: 'user', cmd: 'register'}, user, function(err, data){
        if(err) return done(err);

        //TODO update errors on front-end
        if(!data.ok) return done(data.why);

        profile.userId = data && data.user && data.user.id;
        profile.userType = data && data.user && data.user.initUserType && data.user.initUserType.name;
        
        profile = _.omit(profile,['userTypes', 'password']);

        saveChild(profile, args.user, done);

      });
    }

    function addUserToParentsDojos(profile, done) {
      var parentsDojos = [];
      var userType = profile.userType;
      async.each(profile.parents, function (parent, cb) {
        //Load parents dojos
        var query = {userId: parent};

        seneca.act({role: 'cd-dojos', cmd: 'load_usersdojos', query: query}, function(err, usersDojos){
          if(err) return done(err);
          _.each(usersDojos, function (userDojo) {
            parentsDojos.push(userDojo.dojoId);
          });
          cb();
        });
      }, function (err) {
        async.each(parentsDojos, function (parentDojo, cb) {
          var userDojo = {
            userId:profile.userId,
            owner:0,
            dojoId:parentDojo,
            userTypes:[userType]
          };
          seneca.act({role: 'cd-dojos', cmd: 'save_usersdojos', userDojo: userDojo}, cb);
        }, done);
      });
      
    }

    if(initUserType === 'attendee-o13'){

      async.waterfall([
        async.apply(registerUser, false),
        addUserToParentsDojos
      ], function (err, res) {
        if(err) return done(null, {error: err})
        return done(null, res);
      });

    } else if(initUserType === 'attendee-u13') {
      
      async.waterfall([
        async.apply(registerUser, true),
        addUserToParentsDojos
      ], function (err, res) {
        if(err) return done(null, {error: err});
        return done(null, res);
      });
    }
  }

  function cmd_update_youth(args, done){
    if(!_.contains(args.profile.parents, args.user)){
      return done(new Error('Not authorized to update profile'));
    }
    var profile = args.profile;
    var derivedFields = ['password','userTypes', 'myChild', 'ownProfileFlag', 'dojos'];

    var fieldsToBeRemoved = _.union(derivedFields, immutableFields);
    
    profile = _.omit(profile, fieldsToBeRemoved);
    seneca.make$(PARENT_GUARDIAN_PROFILE_ENTITY).save$(profile, function(err, profile){
      if(err){
        return done(err);
      }

      return done(null, profile);
    });
  }

  function saveChild(profile, parentId, done){
    if(_.contains(profile.parents, parentId)){
      seneca.make$(PARENT_GUARDIAN_PROFILE_ENTITY).save$(profile, function(err, profile){
        if(err){
          return done(err);
        }

        seneca.make$(PARENT_GUARDIAN_PROFILE_ENTITY).list$({userId: parentId}, function(err, results){
          var parent = results[0];

          if(err){
            return done(err);
          }

          parent.children = parent.children ? parent.children : [];
          parent.children.push(profile.userId);

          parent.save$(function(err){
            if(err){
              return done(err);
            }

            return done(null, profile);
          });
        });

      });
    } else {
      return done(new Error('Cannot save child'));
    }
  }

  function cmd_list(args, done){
    var query = args.query;
    var publicFields = [];

    async.waterfall([
      getProfile,
      getUsersDojos,
      getDojosForUser,
      assignUserTypesAndUserPermissions,
      addFlags,
      optionalFieldsFilter,
      privateFilter,
      publicProfilesFilter,
      under13Filter,
      resolveChildren,
      resolveParents
      ],function(err, profile){
        if(err) return done(null, {error: err});
        return done(null, profile);
      });

    function getProfile(done){
      var query = args.query;
      
      if(!query.userId){
        return done(new Error('Internal Error'));
      }

      var publicFields = [];
      seneca.make$(PARENT_GUARDIAN_PROFILE_ENTITY).list$({userId:query.userId}, function(err, results){
        if(err){
          return done(err);
        }

        var profile = results[0];
        if(!profile || !profile.userId){
          return done(new Error('Invalid Profile'));
        }

        return done(null, profile);
      });
    }

    function getUsersDojos(profile, done){
      var query = {userId: profile.userId};

      seneca.act({role: 'cd-dojos', cmd: 'load_usersdojos', query: {userId: query.userId}}, function(err, usersDojos){
        if(err){
          return done(err);
        }

        return done(null, profile, usersDojos);
      });
    }

    function getDojosForUser(profile, usersDojos, done){

      seneca.act({role: 'cd-dojos', cmd: 'dojos_for_user', id: profile.userId}, function(err, dojos){
        if(err){
          return done(err);
        }

        profile.dojos = _.map(dojos, function(dojo){
          return {id: dojo.id, name: dojo.name, urlSlug: dojo.urlSlug};
        });

        return done(null, profile, usersDojos);
      });
    }

    function assignUserTypesAndUserPermissions(profile, usersDojos, done){
      profile.userTypes = [];
      profile.userPermissions = [];

      if(_.isEmpty(usersDojos)){
        profile.userTypes.push(profile.userType);
      } else {
        profile.userTypes = _.flatten(_.pluck(usersDojos, 'userTypes'));
        profile.userTypes.push(profile.userType);
      }

      profile.userPermissions = usersDojos.userPermissions;

      return done(null, profile);
    }

    function addFlags(profile, done){
      profile.ownProfileFlag = profile && profile.userId === args.user ? true : false;
      profile.myChild = _.contains(profile.parents, args.user) ? true : false;
      profile.isTicketingAdmin = _.find(profile.userPermissions, function (profileUserPermission) {
        return profileUserPermission.name === 'ticketing-admin';
      });
      return done(null, profile);
    }

    function optionalFieldsFilter(profile, done) {
      seneca.act({role: 'cd-users', cmd: 'load_champions_for_user', userId: profile.userId}, function (err, champions) {
        if(err) return done(err);
        profile.requestingUserIsChampion = _.find(champions, function (champion) {
          return champion.id === args.user;
        });

        seneca.act({role: 'cd-users', cmd: 'load_dojo_admins_for_user', userId: profile.userId}, function (err, dojoAdmins) {
          if(err) return done(err);
          profile.requestingUserIsDojoAdmin = _.find(dojoAdmins, function (dojoAdmin) {
            return dojoAdmin.id === args.user;
          });

          var allowedFields = [];
          
          if(_.contains(profile.userTypes, 'attendee-o13')){
            allowedFields = _.union(allowedFields, allowedOptionalFields['attendee-o13']);
          }

          if(_.contains(profile.userTypes, 'champion')){
            allowedFields = _.union(allowedFields, allowedOptionalFields['champion']);
          }

          if(_.contains(profile.userTypes, 'mentor')) {
            allowedFields = _.union(allowedFields, allowedOptionalFields['mentor']);
          }

          var keysToOmit = [];
          if(!profile.ownProfileFlag && !profile.myChild && !profile.isTicketingAdmin && !profile.requestingUserIsChampion && !profile.requestingUserIsDojoAdmin){
            _.forOwn(profile.optionalHiddenFields, function(value, key){
              if(value && _.contains(allowedFields, key)){
                keysToOmit.push(key);
              }
            });
          }
          profile = _.omit(profile, keysToOmit);
          return done(null, profile);
        });
      });
    }

    function privateFilter(profile, done){
      if(profile.ownProfileFlag || profile.myChild || profile.isTicketingAdmin || profile.requestingUserIsChampion || profile.requestingUserIsDojoAdmin) {
        return done(null, profile);
      }
      
      if(profile.private){
        profile = {};
      }

      return done(null, profile);
    }

    //TODO cdf-admin role should be able to see all profiles
    function publicProfilesFilter(profile, done) {
      var publicProfileFlag = !profile.requestingUserIsDojoAdmin && !profile.requestingUserIsChampion && !profile.ownProfileFlag && !profile.myChild && !profile.isTicketingAdmin && ( !_.contains(profile.userTypes, 'attendee-u13') || !_.contains(profile.userTypes, 'parent-guardian'));
      if(publicProfileFlag){
         _.each(profile.userTypes, function(userType) {
          publicFields = _.union(publicFields, fieldWhiteList[userType]);
        });

        if(_.contains(profile.userTypes, 'attendee-o13')){
          publicFields = _.remove(publicFields, function(publicField){
            var idx =  youthBlackList.indexOf(publicField);

            return idx > -1 ? false : true;
          });
        }
        
        //Add optional hidden fields to publicFields if they are set to false.
        _.forOwn(profile.optionalHiddenFields, function(value, key){
          if(!value){
            publicFields.push(key);
          }
        });

        profile = _.pick(profile, publicFields);
        return done(null, profile);
      } else {
        return done(null, profile);
      }      
    }

    function under13Filter(profile, done){
      //Ensure that only parents of children can retrieve their full public profile 
      if(_.contains(profile.userTypes, 'attendee-u13') && !_.contains(profile.parents, args.user) && !profile.requestingUserIsChampion && !profile.requestingUserIsDojoAdmin) {
        profile = {};
        return done(null, profile);
      }
      return done(null, profile);
    }


    function resolveChildren(profile, done){
      var resolvedChildren = [];

      if(!_.isEmpty(profile.children) && _.contains(profile.userTypes, 'parent-guardian')){
        async.each(profile.children, function(child, callback){
          seneca.make$(PARENT_GUARDIAN_PROFILE_ENTITY).list$({userId: child}, function(err, results){
            if(err){
              return callback(err);
            } 
            resolvedChildren.push(results[0]);
            return callback();
          });
        }, function(err){
          if(err){
            return done(err);
          }

          profile.resolvedChildren = resolvedChildren;

          return done(null, profile);
        });
      } else {
        profile.resolvedChildren = resolvedChildren;

        return done(null, profile);
      }
    }

    function resolveParents(profile, done){
      var resolvedParents = [];

      if(!_.isEmpty(profile.parents)){
        async.each(profile.parents, function(parent, callback){
          seneca.make$(PARENT_GUARDIAN_PROFILE_ENTITY).list$({userId: parent}, function(err, results){
            if(err){
              return callback(err);
            } 
            resolvedParents.push(results[0]);
            return callback();
          });
        }, function(err){
          if(err){
            return done(err);
          }

          profile.resolvedParents = resolvedParents;

          return done(null, profile);
        });
      } else {
        profile.resolvedParents = resolvedParents;

        return done(null, profile);
      }
    }
  }

  function cmd_save(args, done) {
    var profile = args.profile;

    var profileKeys = _.keys(profile);
    var missingKeys = _.difference(requiredProfileFields, profileKeys);
    if(_.isEmpty(missingKeys)) profile.requiredFieldsComplete = true;

    seneca.make$(PARENT_GUARDIAN_PROFILE_ENTITY).save$(profile, done);
  }

  function cmd_invite_parent_guardian(args, done){
    var inviteToken = uuid.v4();
    var data = args.data;
    var invitedParentEmail = data.invitedParentEmail;
    var childId = data.childId;
    var requestingParentId = args.user;
    
    var childQuery = {
      userId: childId
    };

    var parentQuery = {
      userId: requestingParentId
    };

    async.waterfall([
      resolveChild,
      resolveRequestingParent,
      updateParentProfile,
      sendEmail,
    ], done);


    function resolveChild(done){
      seneca.act({role: plugin, cmd: 'search'}, {query: childQuery}, function(err, results){
        if(err){
          return done(err);
        }

        if(_.isEmpty(results)){
          return done(new Error('Unable to find child profile'));
        }

        if(!_.contains(results[0].parents, args.user)){
          return done(new Error('Not an existing parent or guardian'));
        }

        done(null, results[0]);
      });
    }

    function resolveRequestingParent(childProfile, done){
      seneca.act({role: plugin, cmd: 'search'}, {query: parentQuery}, function(err, results){
        if(err){
          return done(err);
        }

       if(_.isEmpty(results)){
          return done(new Error('Unable to find parent profile'));
        }


        var parentProfile = results[0];
        return done(null, parentProfile, childProfile);
      });
    }

    function updateParentProfile(parentProfile, childProfile, done){
      var timestamp = new Date();
      
      var inviteRequest = {
        token: inviteToken,
        invitedParentEmail: invitedParentEmail,
        childProfileId: childProfile.userId,
        timestamp: timestamp,
        valid: true
      };

      if(!parentProfile.inviteRequests){
        parentProfile.inviteRequests = [];
      }

      parentProfile.inviteRequests.push(inviteRequest);
      
      parentProfile.inviteRequests = _.chain(parentProfile.inviteRequests)
        .sortBy(function(inviteRequest){
          return inviteRequest.timestamp;
        })
        .reverse()
        .value();


      seneca.act({role: plugin, cmd: 'save'}, {profile: parentProfile},function(err, parentProfile){
        if(err){
          return done(err);
        }

        done(err, parentProfile, childProfile, inviteRequest);
      });
    }

    function sendEmail(parentProfile, childProfile, inviteRequest, done){
      if(!childProfile || !parentProfile){
        return done(new Error('An error has occured while sending email'));
      }

      //Externalize year
      var content = {
        link: 'http://localhost:8000/accept-parent-guardian-request/' + parentProfile.userId + '/' + childProfile.userId + '/' + inviteToken,
        childName: childProfile.name,
        parentName: parentProfile.name,
        year: 2015 
      };

      var locality = args.locality || 'en_US';
      var emailSubject = args.emailSubject;
      var code = 'invite-parent-guardian-' + locality;
      var templates = {};

      try {
        templates.html = fs.statSync(path.join(so.mail.folder , code, 'html.ejs'));
        templates.text = fs.statSync(path.join(so.mail.folder , code, 'text.ejs'));


      } catch(err){
        code = 'invite-parent-guardian-' + 'en_US';
      }

      var to =  inviteRequest.invitedParentEmail;

      seneca.act({role:'email-notifications', cmd: 'send', to:to, content:content, code: code, subject: emailSubject}, done);
    }

  }

  function cmd_accept_invite(args, done){
    var data = args.data;
    var inviteToken = data.inviteToken;
    var childProfileId = data.childProfileId;
    var parentProfileId = data.parentProfileId;

    async.waterfall([
      getParentProfile,
      getChildProfile,
      getInvitedParentProfile,
      validateInvite,
      updateInviteParentProfile,
      updateChildProfile,
      invalidateInvitation
    ], function(err){
      if(err){
        return done(err);
      }

      return done();
    });

    function getParentProfile(done){
      seneca.act({role: plugin, cmd: 'search'}, {query: {userId : parentProfileId}}, function(err, results){
        if(err){
          return done(err);
        }

        if(_.isEmpty(results)){
          return done(new Error('Invalid invite'));
        }

        var parent =  results[0];

        if(!_.contains(parent.children, childProfileId)){
          return done(new Error('Cannot add child'));
        }

        return done(null, parent);
      });
    }

    function getChildProfile(parent, done){
      seneca.act({role: plugin, cmd: 'search'}, {query: {userId: childProfileId}}, function(err, results){
        if(err){
          return done(err);
        }

        if(_.isEmpty(results)){
          return done(new Error('Invalid invite'));
        }

        return done(null, parent, results[0]);
      });
    }

    function getInvitedParentProfile (parent, childProfile, done){
      if(!args && args.user){
        return done(new Error('An error occured while attempting to get profile'));
      }
      seneca.act({role: plugin, cmd: 'search'}, {query: {userId: args.user}}, function(err, results){
        if(err){
          return done(err);
        }
        
        if(_.isEmpty(results)){
          return done(new Error('An error occured while attempting to get profile'));
        }

        return done(null, parent, childProfile, results[0]);
      });
    }


    
    function validateInvite(parent, childProfile, invitedParent ,done){
      var inviteRequests = parent.inviteRequests;
      var foundInvite = _.find(inviteRequests, function(inviteRequest){
        return  inviteToken === inviteRequest.token &&
                childProfile.userId === inviteRequest.childProfileId &&
                invitedParent.email === inviteRequest.invitedParentEmail && 
                inviteRequest.valid;
      });

      //Check if user was registered as parent
      if(parent.userType !== 'parent-guardian'){
        return done(new Error('Invitee is not a parent/guardian'));
      }

      //Ensure that same parent cannot be added twice
      if(_.contains(childProfile.parents, invitedParent.userId)){
        return done(new Error('Invitee is already a parent of child'));
      }
      
      if(!foundInvite){
        return done(new Error('Invalid invite'));
      } else { 
        return done(null, parent, invitedParent, childProfile);
      }
    }

    function updateInviteParentProfile(parent, invitedParent, childProfile, done){
      if(!invitedParent.children) {
        invitedParent.children = [];
      }

      invitedParent.children.push(childProfileId);

      invitedParent.save$(function(err, invitedParent){
        if(err){
          return done(err);
        }

        return done(null, parent, invitedParent, childProfile);
      });
    }

    function updateChildProfile(parent, invitedParent, childProfile, done){
      if(!childProfile.parents){
        childProfile.parents = [];
      }

      childProfile.parents.push(invitedParent.userId);

      childProfile.save$(function(err, child){
        if(err){
          return done(err);
        }

        return done(null, parent, invitedParent, childProfile);
      });
    }

    function invalidateInvitation(parent, invitedParent, childProfile, done){
      var inviteRequests = parent.inviteRequests;
      var foundInvite = _.find(inviteRequests, function(inviteRequest){
        return  inviteToken === inviteRequest.token &&
                childProfile.userId === inviteRequest.childProfileId &&
                invitedParent.email === inviteRequest.invitedParentEmail;
      });

      foundInvite.valid = false;

      parent.save$(done);
    }
  }

  function cmd_load_hidden_fields(args, done){
    done(null, hiddenFields);
  }

  function cmd_change_avatar(args, done){
    var file = args.file;

    //pg conf properties
    options.postgresql.database= options.postgresql.name;
    options.postgresql.user= options.postgresql.username;

    pg.connect(options.postgresql, function (err, client) {
      if (err) { return seneca.log.error('Could not connect to postgres', err); }

      var man = new LargeObjectManager(client);

      client.query('BEGIN', function (err) {
        if (err) {
          seneca.log.error('Unable to create transaction');
          done(err);
          return;
        }

        var bufferSize = 16384;
        man.createAndWritableStream(bufferSize, function (err, oid, stream) {
          var noop = function () {};
          var avatarInfo = {
            oid: oid.toString(),
            sizeBytes: 0,
            name: args.fileName,
            type: args.fileType
          };

          if (err) {
            seneca.log.error('Unable to create a new large object');
            client.end();
            done(err);
            done = noop;
            return;
          }

          var buf = new Buffer(file, 'base64');

          stream.write(buf, 'base64', function() {
            stream.end();
          });

          stream.on('data', function (chunk) {
            seneca.log.info('got ' + chunk.length + ' bytes of data');
            avatarInfo.sizeBytes += chunk.length;
          });

          stream.on('finish', function () {
            seneca.log.info('Uploaded largeObject. committing...', oid);
            client.query('COMMIT', function () {
              client.end();
              seneca.log.info('Saved LargeObject', oid);

              //update profile record with avatarInfo
              var profile = {
                id: args.profileId,
                avatar: avatarInfo
              }
              seneca.act({role: plugin, cmd: 'save'}, {profile: profile},function(err, profile){
                if(err){
                  return done(err);
                }

                done(undefined, profile);
                done = noop;
              })

            });
          });

          stream.on('error', function (err) {
            seneca.log.error('postgresql filestore error', err);
            done(err);
            done = noop;
          });
        });
      });
    });
  }

  function cmd_get_avatar(args, done){
    var profileId = args.id;

    //pg conf properties
    options.postgresql.database= options.postgresql.name;
    options.postgresql.user= options.postgresql.username;

    seneca.act({role: plugin, cmd: 'load'}, {id: profileId}, function(err, profile) {
      if(err){
        return done(err);
      }

      if(profile && profile.avatar) {
        pg.connect(options.postgresql, function (err, client) {
          if (err) {
            seneca.log.error('Unable to connect to postgresql', err);
            return done(err);
          }

          var man = new LargeObjectManager(client);

          client.query('BEGIN', function (err) {
            if (err) {
              seneca.log.error('Unable to create transaction', err);
              client.end();
              return done(err);
            }

            // If you are on a high latency connection and working with
            // large LargeObjects, you should increase the buffer size
            var bufferSize = 16384;
            man.openAndReadableStream(profile.avatar.oid, bufferSize, function (err, size, stream) {
              if (err) {
                seneca.log.error('Unable to open readable stream', err);
                client.end();
                return done(err);
              }
              var bufs = [];

              stream.on('data', function(d) {
                bufs.push(d);
              })

              stream.on('end', function () {
                client.query('COMMIT', function () {
                  client.end();
                });

                var buf = bufs.length > 1 ? Buffer.concat(bufs) : Buffer(bufs[0]);
                done(null, {imageData: buf.toString('base64'), imageInfo: profile.avatar});
              });
            });
          });
        });
      } else {
        done();
      }
    });
  }

  function cmd_load(args, done){
    seneca.make$(PARENT_GUARDIAN_PROFILE_ENTITY).load$(args.id, done);
  }

  function cmd_list_query(args, done) {
    var query = args.query;

    var profilesEntity = seneca.make$(PARENT_GUARDIAN_PROFILE_ENTITY);
    profilesEntity.list$(query, done);
  }

  function cmd_load_parents_for_user(args, done) {
    var seneca = this;
    var userId = args.userId;

    seneca.act({role: plugin, cmd: 'list_query', query:{userId: userId}}, function (err, response) {
      if(err) return done(err);
      var childProfile = response[0];
      if(!childProfile || !childProfile.parents) return done();
      async.map(childProfile.parents, function (parentUserId, cb) {
        seneca.act({role: 'cd-users', cmd: 'load', id: parentUserId}, cb);
      }, function (err, parents) { 
        if(err) return done(err);
        return done(null, parents);
      }); 
    });
  }

  function cmd_invite_ninja(args, done) {
    var seneca = this;
    var ninjaData = args.ninjaData;
    var ninjaEmail = ninjaData.ninjaEmail;
    var emailSubject = ninjaData.emailSubject;
    var ninjaProfile;
    var inviteToken;

    async.waterfall([
      validateInviteRequest,
      loadParentProfile,
      addTokenToParentProfile,
      emailNinja,
    ], done);

    function validateInviteRequest(done) {
      //Requesting user should have parent-guardian user type.
      //Ninja email should exist in cd_profiles.
      //Ninja should have attendee-o13 user type.
      async.series([
        validateRequestingUserIsParent,
        validateNinjaEmailExists,
        validateNinjaHasAttendeeO13UserType
      ], done);

      function validateRequestingUserIsParent(done) {
        seneca.act({role: 'cd-dojos', cmd: 'load_usersdojos', query: {userId: args.user}}, function (err, usersDojos) {
          if(err) return done(err);
          var parentUserDojo = usersDojos[0];
          if(_.contains(parentUserDojo.userTypes, 'parent-guardian')) return done();
          return done(new Error('You must be a parent to invite a Ninja'));
        });
      }

      function validateNinjaEmailExists(done) {
        seneca.act({role: plugin, cmd: 'list_query', query: {email: ninjaEmail}}, function (err, ninjaProfiles) {
          if(err) return done(err);
          if(_.isEmpty(ninjaProfiles)) return done(new Error('Invalid invite request. Ninja email does not exist.'));
          ninjaProfile = ninjaProfiles[0];
          return done();
        });
      }

      function validateNinjaHasAttendeeO13UserType(done) {
        seneca.act({role: 'cd-dojos', cmd: 'load_usersdojos', query: {userId: ninjaProfile.userId}}, function (err, ninjaUsersDojos) {
          if(err) return done(err);
          var attendeeO13TypeFound = _.find(ninjaUsersDojos, function (ninjaUserDojo) {
            return _.contains(ninjaUserDojo.userTypes, 'attendee-o13');
          });
          if(attendeeO13TypeFound || ninjaProfile.userType === 'attendee-o13') return done();
          return done(new Error('Ninja must be an over 13 attendee'));
        });
      }
    }

    function loadParentProfile(validationResponse, done) {
      seneca.act({role: plugin, cmd: 'list_query', query: {userId: args.user}}, done);
    }

    function addTokenToParentProfile(profiles, done) {
      var parentProfile = profiles[0];
      inviteToken = {
        id: shortid.generate(),
        ninjaEmail: ninjaEmail,
        parentProfileId: parentProfile.id,
        timestamp: new Date()
      };

      if(!parentProfile.ninjaInvites) parentProfile.ninjaInvites = [];
      parentProfile.ninjaInvites.push(inviteToken);
      parentProfile.ninjaInvites = _.chain(parentProfile.ninjaInvites)
        .sortBy(function (ninjaInvite) {
          return ninjaInvite.timestamp;
        })
        .reverse()
        .uniq(function (ninjaInvite) {
          return ninjaInvite.ninjaEmail;
        })
        .value();
      seneca.act({role: plugin, cmd: 'save', profile: parentProfile}, done);
    }

    function emailNinja(parentProfile, done) {
      var zenHostname = args.zenHostname;
      var content = {
        ninjaName: ninjaProfile.name,
        parentName: parentProfile.name,
        parentEmail: parentProfile.email,
        link: 'http://'+zenHostname+'/dashboard/approve_invite_ninja/'+inviteToken.parentProfileId+'/'+inviteToken.id,
        year: moment(new Date()).format('YYYY')
      };
      var locality = args.locality || 'en_US';
      var code = 'invite-ninja-over-13-' + locality;
      seneca.act({role:'email-notifications', cmd: 'send', to:ninjaEmail, content:content, code: code, subject: emailSubject}, done);
    }

  }

  function cmd_approve_invite_ninja(args, done) {
    var seneca = this;
    var inviteData = args.data;
    var ninjaProfile;
    var parentProfile;

    async.series([
      validateRequest,
      updateNinjaAndParentProfiles,
      addNinjaToParentsDojos
    ], done);

    function validateRequest(done) {
      seneca.act({role: plugin, cmd: 'load', id: inviteData.parentProfileId}, function (err, response) {
        if(err) return done(err);
        parentProfile = response;
        if(!parentProfile.ninjaInvites) return done(new Error('No invite tokens exist for this profile'));
        var inviteTokenFound = _.find(parentProfile.ninjaInvites, function (ninjaInvite) {
          return ninjaInvite.id === inviteData.inviteTokenId;
        });
        if(!inviteTokenFound) return done(new Error('Invalid token'));

        seneca.act({role: plugin, cmd: 'list_query', query: {userId: args.user}}, function (err, ninjaProfiles) {
          if(err) return done(err);
          ninjaProfile = ninjaProfiles[0];
          if(ninjaProfile.email !== inviteTokenFound.ninjaEmail) return done(new Error('You cannot approve invite Ninja requests for other users.'));
          return done();
        });

      });
    }

    function updateNinjaAndParentProfiles(done) {
      //Add parent user id to Ninja parents array
      //Add ninja user id to Parent children array
      if(!parentProfile.children) parentProfile.children = [];
      parentProfile.children.push(ninjaProfile.userId);
      parentProfile.ninjaInvites = _.without(parentProfile.ninjaInvites, _.findWhere(parentProfile.ninjaInvites, {id:inviteData.inviteTokenId}));

      if(!ninjaProfile.parents) ninjaProfile.parents = [];
      ninjaProfile.parents.push(parentProfile.userId);

      seneca.act({role: plugin, cmd: 'save', profile: parentProfile}, function (err, response) {
        if(err) return done(err);
        seneca.act({role: plugin, cmd: 'save', profile: ninjaProfile}, done);
      });
    }

    function addNinjaToParentsDojos(done) {
      seneca.act({role: 'cd-dojos', cmd: 'load_usersdojos', query: {userId:parentProfile.userId}}, function (err, parentUsersDojos) {
        if(err) return done(err);
        async.each(parentUsersDojos, function (parentUserDojo, cb) {
          seneca.act({role: 'cd-dojos', cmd: 'load_usersdojos', query: {userId: ninjaProfile.userId, dojoId: parentUserDojo.dojoId}}, function (err, ninjaUsersDojos) {
            if(err) return cb(err);
            if(!_.isEmpty(ninjaUsersDojos)) return cb(); // Ninja is already a member of this Dojo.
            var userDojo = {
              owner: 0,
              userId: ninjaProfile.userId,
              dojoId: parentUserDojo.dojoId,
              userTypes:['attendee-o13']
            };
            seneca.act({role: 'cd-dojos', cmd: 'save_usersdojos', userDojo: userDojo}, cb);
          });
        }, done);
      });
    }
    
  }

  return {
    name: plugin
  };

};