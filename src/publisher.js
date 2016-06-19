'use strict';

var checkTypes = require('check-types'),
	_ = require('underscore'),
	logger = require('./logger'),
	path = require('path'),
	fs = require('fs'),
	url = require('url'),
	q = require('q'),
	http = require('request'),
	urlJoin = require('url-join');

function Publisher(pactBroker, pactUrls, consumerVersion, pactBrokerUsername, pactBrokerPassword) {
	this.options = {};
	this.options.pactBroker = pactBroker;
	this.options.pactUrls = pactUrls;
	this.options.pactBrokerUsername = pactBrokerUsername;
	this.options.pactBrokerPassword = pactBrokerPassword;
	this.options.consumerVersion = consumerVersion;
}

Publisher.prototype.publish = function () {
	var options = this.options;
	logger.info('Publishing pacts to broker at: ' + options.pactBroker);

	// Stat all paths in pactUrls to make sure they exist
	// publish template $pactHost/pacts/provider/$provider/consumer/$client/$version
	var uris = _.chain(options.pactUrls)
		.map(function (uri) {
			var localFileOrDir = path.normalize(uri);
			if (!(/^http/.test(uri)) && fs.statSync(localFileOrDir).isDirectory()) {
				uri = localFileOrDir;
				return _.map(fs.readdirSync(uri, ''), function (file) {
					if (/.json$/.test(file)) {
						return path.join(uri, file);
					}
				});
			} else {
				return uri;
			}
		})
		.flatten(true)
		.compact()
		.value();

	// Return a merge of all promises...
	return q.all(_.map(uris, function (uri) {
		// Authentication
		var auth = null;

		if (options.pactBrokerUsername && options.pactBrokerPassword) {
			auth = {
				user: options.pactBrokerUsername,
				pass: options.pactBrokerPassword
			}
		}

		try {
			var deferred = q.defer();

			// Promise to update provider/consumer
			var getPactCollaborators;

			// Parse the Pact file to extract consumer/provider names
			if (/.json$/.test(uri)) {
				var readFile = q.nfbind(fs.readFile);
				getPactCollaborators = readFile(uri, 'utf8')
					.then(function(data) {
						return JSON.parse(data)
					}, function(err) {
						return q.reject(err);
					})
			} else {
				var request = q.denodeify(http);
				var config = {
					uri: uri,
					method: 'GET',
					headers: {
						'Accept': 'application/json'
					},
					json: true,
					auth: auth
				};
				getPactCollaborators = request(config)
					.then(function(data) {
						var body = data[0].body;
						if (data[0].statusCode != 200) {
							return q.reject(new Error('Cannot GET ' + uri + '. Nested exception: ' + body))
						}
						return body;
					}, function(err) {
						return q.reject(err);
					})
			}

			return getPactCollaborators
				.then(function(data) {
					var config = {
						uri: urlJoin(options.pactBroker, 'pacts/provider', data.provider, 'consumer', data.consumer, 'version', options.consumerVersion),
						method: 'PUT',
						headers: {
							'Content-Type': 'application/json',
							'Accept': 'application/json'
						},
						body: data,
						json: true,
						auth: auth
					};

					http(config, function (error, response) {
						if (!error && response.statusCode == 200) {
							deferred.resolve();
						} else {
							deferred.reject();
						}
					});

					return deferred.promise;
				}, function(err) {
					return q.reject(err);
				})

		} catch (e) {
			return q.reject("Invalid Pact file: " + uri + ". Nested exception: " + e.message);
		}
	}))
};

// Creates a new instance of the pact server with the specified option
module.exports = function (options) {
	options = options || {};
	options.pactBroker = options.pactBroker || '';
	options.pactUrls = options.pactUrls || [];

	if (options.pactUrls) {
		checkTypes.assert.array.of.string(options.pactUrls);
	}

	// Stat all paths in pactUrls to make sure they exist
	var url = require('url');
	_.each(options.pactUrls, function (uri) {
		// only check local files
		var proto = url.parse(uri).protocol;
		if (proto == 'file://' || proto === null) {
			try {
				fs.statSync(path.normalize(uri))
			} catch (e) {
				throw new Error('Pact file or directory: "' + uri + '" doesn\'t exist');
			}
		}
	});

	checkTypes.assert.nonEmptyString(options.pactBroker, 'Must provide the pactBroker argument');
	checkTypes.assert.nonEmptyString(options.consumerVersion, 'Must provide the consumerVersion argument');
	checkTypes.assert.not.emptyArray(options.pactUrls, 'Must provide the pactUrls argument');

	if (options.pactBrokerUsername) {
		checkTypes.assert.string(options.pactBrokerUsername);
	}

	if (options.pactBrokerPassword) {
		checkTypes.assert.string(options.pactBrokerPassword);
	}

	if ((options.pactBrokerUsername && !options.pactBrokerPassword) || (options.pactBrokerPassword && !options.pactBrokerUsername)) {
		throw new Error('Must provide both or none of --provider-states-url and --provider-states-setup-url.');
	}

	if (options.pactBroker) {
		checkTypes.assert.string(options.pactBroker);
	}

	return new Publisher(options.pactBroker, options.pactUrls, options.consumerVersion, options.pactBrokerUsername, options.pactBrokerPassword);
};
