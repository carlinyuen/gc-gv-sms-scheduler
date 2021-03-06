// This background process should check every minute
//	and see if we need to send out scheduled texts

// Global Variables & Constants
var manifest = chrome.runtime.getManifest();	// Manifest reference
var OK = 0
	, REFRESH_INTERVAL = 60000			// 60000 ms = 1 minute
	, ERROR_INVALID_INPUT = -1
	, ERROR_NO_MESSAGES = -2
	, ERROR_MISSING_MESSAGE = -3
	, ERROR_STORAGE_ISSUE = -4
	, ERROR_API_ISSUE = -5;
var STORAGE_KEY = 'scheduledMessages';
var GOOGLE_VOICE_DATA_REQUEST_URL = "https://www.google.com/voice/b/0/request/user/";
var GOOGLE_VOICE_SEND_SMS_REQUEST_URL = "https://www.google.com/voice/b/0/sms/send/";

var PAGE_ID = new Date().getTime();	// 'Unique' id for background page for locking
var _rnr_se;	// Google Voice account key of some sort, needed for sms

// Convert javscript date to and from UTC
function convertDateToUTC(date)
{
	return new Date(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(),
		date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds());
}
function convertDateToLocal(date)
{
	return new Date($.datepicker.formatDate("m/d/yy", date) + " "
		+ $.datepicker.formatTime("H:mm:ss:l", {
			hour: date.getHours(), minute: date.getMinutes(),
			second: date.getSeconds(), millisecond: date.getMilliseconds()
		}) + " UTC");
}

// Execute our content script into the given tab
var contentScripts = manifest.content_scripts[0].js;
function injectScript(tab)
{
	// Insanity check
	if (!tab || !tab.id) {
		console.log("Injecting into invalid tab:", tab);
		return;
	}

	// Loop through content scripts and execute in order
    for (var i = 0, l = contentScripts.length; i < l; ++i) {
        chrome.tabs.executeScript(tab.id, {
            file: contentScripts[i]
        });
    }
}

// Listen to when extension is first installed or upgraded
chrome.runtime.onInstalled.addListener(function(details)
{
	console.log("onInstalled: " + details.reason);

	// On first install, go through and inject content script into GVoice tabs
	if (details.reason == "install" || details.reason == "update")
	{
		// Execute our content script into the given tab
		var contentScripts = manifest.content_scripts[0].js;
		chrome.tabs.query({url:"*://www.google.com/voice*"}, function(tabs) {
			if (tabs.length) {
				for (var i = tabs.length - 1; i >= 0; --i) {
					// Loop through content scripts and execute in order
					for (var s = 0, l = contentScripts.length; s < l; ++s) {
						chrome.tabs.executeScript(tabs[i].id, {
							file: contentScripts[s]
						});
					}
				}
			}
			else if (details.reason == "install") {
				// No google voice page open on first install! Open for them.
				chrome.tabs.create({url: "https://voice.google.com"});
			}
		});
	}

	// If upgrade and new version number, notify user with notification
	if (details.reason == "update" && details.previousVersion != manifest.version)
	{
		// Notify user
		chrome.notifications.create("", {
			type: "basic"
			, iconUrl: "images/icon128.png"
			, title: "GoogleVoice Scheduler Updated!"
			, message: "Hi there! Please refresh your tabs to use it. Happy scheduling! :o)"
		}, function(id) {});

		// Loop through GVoice tabs and tell them to refresh
		chrome.tabs.query({url:"*://www.google.com/voice*"}, function(tabs) {
			for (var i = tabs.length - 1; i >= 0; --i) {
				chrome.tabs.sendMessage(tabs[i].id, {
					action: "refreshPage"
				});
			}
		});
	}
});


// Initialize extension
function initExtension()
{
	// Page ID
	console.log("initExtension:", PAGE_ID);

	// Retreive data from Google Voice's API calls
	$.ajax({
		type: 'GET',
		url: GOOGLE_VOICE_DATA_REQUEST_URL,
		success: processGoogleDataResponse,
		error: processGoogleDataResponse,
	});
}

// Handle Google Voice data request response
function processGoogleDataResponse(response)
{
	if (response && response.responseText)
	{
		var data = $.parseJSON(response.responseText);
		_rnr_se = data.r;
		console.log("processGoogleDataResponse", _rnr_se);

		// Check if we successfully retrieved the key
		if (_rnr_se) {
			setInterval(checkScheduledMessages, REFRESH_INTERVAL);
		} else {
			console.log("Could not retrieve _rnr_se!");
			setTimeout(initExtension, REFRESH_INTERVAL);
		}
	}
	else	// Error, no data!
	{
		console.log(chrome.i18n.getMessage("ERROR_API_ISSUE"));
		setTimeout(initExtension, REFRESH_INTERVAL);
	}
}

// Handler to listen for messages from the content script
chrome.runtime.onMessage.addListener(
	function(request, sender, sendResponse)
	{
		// Have to return true to send a response after listener returns
		switch (request.action)
		{
			case "sendMessage":
				sendMessage(request.messageID, sendResponse);
				return true;

			case "removeMessage":
				removeMessage(request.messageID, sendResponse);
				return true;

			case "getAccountKey":
				sendResponse(_rnr_se);
				return true;

			default:
				console.log("Unknown request:", request, sender);
				return false;
		}
	});

// Send SMS message with given ID through google voice
function sendMessage(messageID, sendResponse)
{
	console.log("sendMessage", messageID);

	// Go through messages and remove sent message
	chrome.storage.local.get(STORAGE_KEY, function(items)
	{
		// Check if no messages
		if (!items || !items[STORAGE_KEY] || !items[STORAGE_KEY].length)
		{
			console.log(chrome.i18n.getMessage("STATUS_NO_MESSAGES"));
			if (sendResponse) {		// If response function exists
				sendResponse({
					status: ERROR_NO_MESSAGES,
					message: chrome.i18n.getMessage("STATUS_NO_MESSAGES")
				});
			}
			return;
		}

		// Loop through and check if there's an id match
		var messages = items[STORAGE_KEY];
		for (var i = messages.length - 1; i >= 0; --i)
		{
			// Message found
			if (messages[i].id == messageID)
			{
				var message = messages[i];
				$.ajax({
					type: 'POST',
					url: GOOGLE_VOICE_SEND_SMS_REQUEST_URL,
					data: {
						id: "",
						phoneNumber: message.recipients,
						text: message.text,
						sendErrorSms: 0,
						_rnr_se: _rnr_se,
					},
					success: function(response) {
						processSendSMSResponse(message, response, sendResponse);
					},
					error: function(response) {
						processSendSMSResponse(message, response, sendResponse);
					}
				});

				return;
			}
		}

		// If message was not found, respond with error
		console.log(chrome.i18n.getMessage("ERROR_MISSING_MESSAGE"));
		if (sendResponse) {		// If response function exists
			sendResponse({
				status: ERROR_MISSING_MESSAGE,
				message: chrome.i18n.getMessage("ERROR_MISSING_MESSAGE")
			});
		}
	});
}

function processSendSMSResponse(message, response, sendResponse)
{
	if (response)
	{
		var data = $.parseJSON(response.responseText);
		console.log("processSendSMSResponse", data.ok);

		// Check if we successfully sent sms
		if (data.ok)
		{
			// Tell tabs to remove message from UI
			chrome.tabs.query({url:"*://www.google.com/voice*"}, function(tabs)
			{
				for (var i = tabs.length - 1; i >= 0; --i)
				{
					chrome.tabs.sendMessage(tabs[i].id, {
						action: "messageSent",
						messageID: message.id
					});
				}
			});

			// Test for notification support, and show notification
			showNotification("images/icon48.png"
				, "SMS Message sent to " + message.recipients
				, message.text);

			// Go through messages and remove sent message
			removeMessage(message.id, sendResponse);
		}
		else	// Error!
		{
			if (sendResponse) {		// If response function exists
				sendResponse({
					status: response.status,
					message: response.responseText
				});
			}
		}
	}
	else
	{
		console.log(chrome.i18n.getMessage("ERROR_API_ISSUE"));
		if (sendResponse) {		// If response function exists
			sendResponse({
				status: ERROR_API_ISSUE,
				message: chrome.i18n.getMessage("ERROR_API_ISSUE")
			});
		}
	}
}

// Show notification for sent messages
function showNotification(imagePath, title, message)
{
	var data = {
		type: "basic"
		, iconUrl: imagePath	// The image.
		, title: title			// The title.
		, message: message		// The body.
		, contextMessage: (new Date()).toLocaleString()
		, eventTime: Date.now()
	};
	chrome.notifications.create("", data, function(id) {});
}

// Remove a message with given ID, and return response through sendResponse
function removeMessage(messageID, sendResponse)
{
	console.log("removeMessage", messageID);

	// Go through messages and remove sent message
	chrome.storage.local.get(STORAGE_KEY, function(items)
	{
		// Check if no messages
		if (!items || !items[STORAGE_KEY] || !items[STORAGE_KEY].length)
		{
			console.log(chrome.i18n.getMessage("STATUS_NO_MESSAGES"));
			if (sendResponse) {		// If response function exists
				sendResponse({
					status: ERROR_NO_MESSAGES,
					message: chrome.i18n.getMessage("STATUS_NO_MESSAGES")
				});
			}
			return;
		}

		// Loop through and check if there's an id match
		var messages = items[STORAGE_KEY];
		var messageFound = false;
		for (var i = messages.length - 1; i >= 0; --i)
		{
			if (messages[i].id == messageID)
			{
				// Delete from data
				messages.splice(i, 1);
				messageFound = true;
				break;
			}
		}

		// If message was found and removed, update data
		if (messageFound)
		{
			// Store new data back in, and print error if any
			var data = {};
			data[STORAGE_KEY] = messages;
			chrome.storage.local.set(data, function() {
				if (chrome.runtime.lastError)
				{
					console.log(chrome.runtime.lastError);
					if (sendResponse) {		// If response function exists
						sendResponse({
							status: ERROR_STORAGE_ISSUE,
							message: chrome.runtime.lastError
						});
					}
				}
				else
				{
					console.log("removeMessage success:", messageID);
					if (sendResponse) {		// If response function exists
						sendResponse({
							status: OK,
							message: ""
						});
					}
				}
			});
		}
		else	// Error - couldn't find it!
		{
			console.log(chrome.i18n.getMessage("ERROR_MISSING_MESSAGE"));
			if (sendResponse) {		// If response function exists
				sendResponse({
					status: ERROR_MISSING_MESSAGE,
					message: chrome.i18n.getMessage("ERROR_MISSING_MESSAGE")
				});
			}
		}
	});
}

function checkScheduledMessages()
{
	// Get list of scheduled messages and see if
	//	any of them should be sent out
	chrome.storage.local.get(STORAGE_KEY, function(items)
	{
		// Check if no messages
		if (!items || !items[STORAGE_KEY] || !items[STORAGE_KEY].length) {
			return;
		}

		// Compare against different dates for checking and resetting
		var currentDateTime = new Date();
		var checkDateTime = new Date(currentDateTime.getTime() + 2 * REFRESH_INTERVAL);
		var resetDateTime = new Date(currentDateTime.getTime() - 2 * REFRESH_INTERVAL);

		// Loop through and check datetimes
		var messages = items[STORAGE_KEY];
		var messagesToSend = [];
		for (var i = messages.length - 1, message = messages[i];
				i >= 0; message = messages[--i])
		{
			// Check if lock is ours
			if (PAGE_ID == message.lock) {
				messagesToSend.push(message.id);
			}
			else	// Not ours, see if we should lock it or reset it
			{
				// Compare times
				var messageDateTime = convertDateToLocal(
					new Date($.parseJSON(message.dateTime)));

				if (!message.lock)	// No lock, attempt to lock
				{
					// If message date is in range, set lock
					if (messageDateTime <= checkDateTime) {
						message.lock = PAGE_ID;
					}
				}
				else	// Has lock, but maybe computer didn't serve it?
				{
					// If message > 2 mins old than intended send time,
					//  reset lock and change message time to reflect
					if (messageDateTime < resetDateTime) {
						message.lock = null;
						message.dateTime = JSON.stringify(convertDateToUTC(checkDateTime))
					}
				}
			}
		}

		// Sync back data and send messages that are locked for this page
		var data = {};
		data[STORAGE_KEY] = messages;
		chrome.storage.local.set(data, function() {
			if (chrome.runtime.lastError) {
				console.log(chrome.runtime.lastError);
			} else {
				$.each(messagesToSend, function(index, id) {
					sendMessage(id);
				});
			}
		});

	});
}

// Setup the extension
initExtension();

