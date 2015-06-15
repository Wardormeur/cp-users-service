'use strict';

var createEvent = require('./create-event');
var getEvent = require('./get-event');
var listEvents = require('./list-events');


module.exports = function() {
    var seneca = this;
    var plugin = 'cd-events';

    seneca.add({
        role: plugin,
        cmd: 'createEvent'
    }, createEvent.bind(seneca));

    seneca.add({
        role: plugin,
        cmd: 'getEvent'
    }, getEvent.bind(seneca));

    seneca.add({
        role: plugin,
        cmd: 'listEvents'
    }, listEvents.bind(seneca));

    return {
        name: plugin
    };
};