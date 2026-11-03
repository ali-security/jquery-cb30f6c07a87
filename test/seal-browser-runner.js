/*
 * Seal fork-CI driver: runs the jQuery QUnit suite (test/index.html) in
 * headless Chrome via puppeteer-core and reports results on stdout.
 *
 * Usage: node test/seal-browser-runner.js <url>
 *   CHROME_PATH       Chrome/Chromium executable (required)
 *   SEAL_TEST_FILTER  optional QUnit `filter` (substring of "module: test")
 *   SEAL_SKIP_TESTS   optional "||"-separated list of exact "module: test" names
 *                     that are not registered (printed as SKIPPED), each
 *                     optionally followed by " :: <reason>" (printed with it)
 *
 * puppeteer-core is resolved via NODE_PATH from a separate driver tree, so
 * this repo's node 0.10 node_modules is never touched.
 *
 * Exit: 0 all green, 1 failures, 2 timeout / suite never finished.
 */
/*jshint node: true */
/*global Promise: false */
(function() {
"use strict";

var puppeteer = require( "puppeteer-core" ),
	OVERALL_TIMEOUT_MS = 40 * 60 * 1000,
	HEARTBEAT_MS = 120 * 1000,
	PREFIX = "__SEAL__",
	targetUrl = process.argv[ 2 ],
	filter = process.env.SEAL_TEST_FILTER || "",
	skipReasons = {},
	skipList = ( process.env.SEAL_SKIP_TESTS || "" ).split( "||" ).map(function( s ) {
		var parts = s.split( " :: " ),
			name = parts[ 0 ].trim();
		skipReasons[ name ] = parts.slice( 1 ).join( " :: " ).trim() || "(no reason given)";
		return name;
	}).filter(function( s ) {
		return s.length > 0;
	});

if ( !targetUrl ) {
	console.error( "usage: node test/seal-browser-runner.js <url>" );
	process.exit( 2 );
}
if ( !process.env.CHROME_PATH ) {
	console.error( "CHROME_PATH is not set" );
	process.exit( 2 );
}
if ( filter ) {
	targetUrl += ( targetUrl.indexOf( "?" ) >= 0 ? "&" : "?" ) + "filter=" + encodeURIComponent( filter );
}

/*
 * Runs in every frame before any page script. Only the top frame is hooked:
 * the suite spawns many iframes that load QUnit themselves.
 */
function pageHook( skipNames ) {
	// Snapshot natives up front: the ajax "getJSON() - Using Native JSON" test
	// replaces window.JSON with a parse-only stub, and calling JSON.stringify
	// from the reporter while it is installed wedges the whole suite.
	var nativeJSON = window.JSON,
		nativeStringify = nativeJSON.stringify,
		nativeLog = window.console.log,
		nativeConsole = window.console,
		skip = {},
		hooked = false,
		winLoaded = false,
		qunitRef, i;

	if ( window.top !== window ) {
		return;
	}

	// Registered before qunit.js runs, so it fires ahead of QUnit's own
	// window "load" listener.
	window.addEventListener( "load", function() {
		winLoaded = true;
	});

	for ( i = 0; i < skipNames.length; i++ ) {
		skip[ skipNames[ i ] ] = true;
	}

	function emit( type, data ) {
		try {
			nativeLog.call( nativeConsole, "__SEAL__" + nativeStringify.call( nativeJSON, { type: type, data: data } ) );
		} catch ( e ) {
			try {
				nativeLog.call( nativeConsole, "__SEAL__" + nativeStringify.call( nativeJSON, {
					type: type, data: { error: "unserializable payload: " + e }
				}) );
			} catch ( e2 ) {}
		}
	}

	function dump( value ) {
		var out;
		try {
			if ( qunitRef && qunitRef.jsDump ) {
				out = qunitRef.jsDump.parse( value );
			} else {
				out = String( value );
			}
		} catch ( e ) {
			try {
				out = String( value );
			} catch ( e2 ) {
				out = "<undumpable>";
			}
		}
		if ( typeof out === "string" && out.length > 2000 ) {
			out = out.slice( 0, 2000 ) + "...";
		}
		return out;
	}

	function setupConfig( config ) {
		config.reorder = false;
		config.testTimeout = 60000;

		// QUnit's logging-callback registration (QUnit.moduleStart etc.) is
		// added after QUnit.config is exported; registering a callback is just
		// a push onto these config queues, so push directly.
		config.begin.push(function() {
			emit( "begin", {} );
		});
		config.moduleStart.push(function( d ) {
			emit( "moduleStart", { name: d.name } );
		});
		config.testStart.push(function( d ) {
			// test/data/testrunner.js resets testTimeout to 20s after QUnit
			// loads; re-apply before every test (asyncTest reads it at stop()).
			config.testTimeout = 60000;
			emit( "testStart", { name: d.name, module: d.module } );
		});
		config.log.push(function( d ) {
			if ( d.result ) {
				return;
			}
			emit( "log", {
				module: d.module,
				name: d.name,
				message: d.message === undefined ? "" : String( d.message ),
				actual: dump( d.actual ),
				expected: dump( d.expected ),
				source: d.source === undefined ? "" : String( d.source )
			});
		});
		config.testDone.push(function( d ) {
			emit( "testDone", {
				name: d.name,
				module: d.module,
				failed: d.failed,
				passed: d.passed,
				total: d.total
			});
		});
		config.done.push(function( d ) {
			emit( "done", {
				failed: d.failed,
				passed: d.passed,
				total: d.total,
				runtime: d.runtime
			});
		});
	}

	function hookQUnit( q ) {
		var origTest, wrappedTest, configRef;

		if ( hooked || !q ) {
			return;
		}
		hooked = true;

		// Skip support: every registration path ends in QUnit.test (window.test,
		// asyncTest -> QUnit.test, testIframe/testIframeWithCallback -> test),
		// where the effective module/name is known.
		origTest = q.test;
		wrappedTest = function( testName ) {
			var cfg = q.config,
				mod = cfg && cfg.currentModule,
				key = ( mod ? mod + ": " : "" ) + testName;
			if ( skip[ key ] ) {
				emit( "skip", { name: key } );
				return;
			}
			return origTest.apply( this, arguments );
		};
		q.test = wrappedTest;
		window.test = wrappedTest;

		// QUnit.load runs twice upstream: qunit.js binds it to window "load",
		// and test/data/testinit.js calls QUnit.load() + QUnit.start() once
		// require has loaded every test file. When require wins the race and
		// window "load" (it waits for the suite's iframes) fires after the
		// tests have started, the second QUnit.load re-renders #qunit-tests
		// under the running test and QUnit throws ("Cannot set properties of
		// null (setting 'className')"), wedging the suite. Defer testinit's
		// early load/start until after window "load", which is the order
		// upstream gets whenever window "load" fires first.
		( function() {
			var origLoad = q.load,
				origStart = q.start;
			q.load = function() {
				if ( winLoaded ) {
					return origLoad.apply( this, arguments );
				}
				emit( "deferred", { what: "QUnit.load (window load listener runs it)" } );
			};
			q.start = function() {
				var self = this,
					args = arguments;
				if ( winLoaded ) {
					return origStart.apply( self, args );
				}
				emit( "deferred", { what: "QUnit.start until window load" } );
				window.addEventListener( "load", function() {
					setTimeout(function() {
						origStart.apply( self, args );
					}, 0 );
				});
			};
		})();

		if ( q.config ) {
			setupConfig( q.config );
		} else {
			// qunit.js exports window.QUnit before extend(QUnit, { config: ... })
			Object.defineProperty( q, "config", {
				configurable: true,
				enumerable: true,
				get: function() {
					return configRef;
				},
				set: function( c ) {
					configRef = c;
					Object.defineProperty( q, "config", {
						configurable: true,
						enumerable: true,
						writable: true,
						value: c
					});
					setupConfig( c );
				}
			});
		}
	}

	Object.defineProperty( window, "QUnit", {
		configurable: true,
		enumerable: true,
		get: function() {
			return qunitRef;
		},
		set: function( v ) {
			qunitRef = v;
			hookQUnit( v );
		}
	});
}

function pad( s, n ) {
	s = String( s );
	while ( s.length < n ) {
		s += " ";
	}
	return s;
}

function main() {
	var browser, page, heartbeatTimer, overallTimer,
		finished = false,
		done = null,
		modules = {},
		moduleOrder = [],
		failedTests = 0,
		passedTests = 0,
		skippedTests = [],
		currentTest = null,
		lastProgress = Date.now(),
		lastHeartbeat = Date.now();

	function moduleStats( name ) {
		if ( !modules[ name ] ) {
			modules[ name ] = { tests: 0, failedTests: 0, assertions: 0, failedAssertions: 0 };
			moduleOrder.push( name );
		}
		return modules[ name ];
	}

	function printSummary() {
		var totalTests = passedTests + failedTests;
		console.log( "" );
		console.log( "==================== SUMMARY ====================" );
		if ( skippedTests.length ) {
			console.log( "Skipped (not registered): " + skippedTests.length );
			skippedTests.forEach(function( n ) {
				console.log( "  SKIPPED: " + n + " -- reason: " + skipReasons[ n ] );
			});
		}
		console.log( pad( "module", 28 ) + pad( "tests", 8 ) + pad( "failed", 8 ) +
			pad( "assertions", 12 ) + "failed" );
		moduleOrder.forEach(function( name ) {
			var m = modules[ name ];
			console.log( pad( name, 28 ) + pad( m.tests, 8 ) + pad( m.failedTests, 8 ) +
				pad( m.assertions, 12 ) + m.failedAssertions );
		});
		if ( done ) {
			console.log( "Tests: " + passedTests + " passed, " + failedTests + " failed, " +
				totalTests + " total; Assertions: " + done.passed + " passed, " + done.failed +
				" failed, " + done.total + " total; runtime " + done.runtime + " ms" );
		} else {
			console.log( "Tests: " + passedTests + " passed, " + failedTests + " failed, " +
				totalTests + " total; QUnit done NEVER fired" );
		}
	}

	function finish( code, reason ) {
		var closing;
		if ( finished ) {
			return;
		}
		finished = true;
		clearInterval( heartbeatTimer );
		clearTimeout( overallTimer );
		if ( reason ) {
			console.log( reason );
		}
		printSummary();
		closing = browser ? browser.close() : Promise.resolve();
		closing[ "catch" ](function() {}).then(function() {
			exitFlushed( code );
		});
		// Do not let a hung browser.close() keep us alive.
		setTimeout(function() {
			exitFlushed( code );
		}, 15000 ).unref();
	}

	// stdout to a pipe is asynchronous: a bare process.exit() drops whatever
	// is still buffered (the per-test lines and the summary). The write
	// callback fires once everything queued before it has been flushed.
	function exitFlushed( code ) {
		process.stdout.write( "", function() {
			process.exit( code );
		});
	}

	function onEvent( ev ) {
		var d = ev.data || {},
			m;
		switch ( ev.type ) {
		case "begin":
			console.log( "QUnit begin" );
			break;
		case "moduleStart":
			console.log( "MODULE " + d.name );
			break;
		case "testStart":
			currentTest = ( d.module ? d.module + ": " : "" ) + d.name;
			break;
		case "log":
			console.log( "    assertion failed: " + d.message );
			console.log( "      expected: " + d.expected );
			console.log( "      actual:   " + d.actual );
			if ( d.source ) {
				console.log( "      source:   " + String( d.source ).split( "\n" ).join( "\n                " ) );
			}
			break;
		case "testDone":
			lastProgress = Date.now();
			lastHeartbeat = lastProgress;
			currentTest = null;
			m = moduleStats( d.module || "(no module)" );
			m.tests++;
			m.assertions += d.total;
			m.failedAssertions += d.failed;
			if ( d.failed > 0 ) {
				m.failedTests++;
				failedTests++;
			} else {
				passedTests++;
			}
			console.log( ( d.failed > 0 ? "FAIL" : "PASS" ) + " [" + d.module + "] " + d.name +
				" (" + d.passed + "/" + d.total + ")" );
			break;
		case "deferred":
			console.log( "deferred " + d.what );
			break;
		case "skip":
			skippedTests.push( d.name );
			console.log( "SKIPPED: " + d.name + " -- reason: " + skipReasons[ d.name ] );
			break;
		case "done":
			done = d;
			finish( d.failed === 0 && failedTests === 0 ? 0 : 1 );
			break;
		default:
			console.log( "unknown event type: " + ev.type );
		}
	}

	overallTimer = setTimeout(function() {
		finish( 2, "TIMEOUT: suite did not finish within " + ( OVERALL_TIMEOUT_MS / 60000 ) +
			" minutes" + ( currentTest ? " (running: " + currentTest + ")" : "" ) );
	}, OVERALL_TIMEOUT_MS );

	heartbeatTimer = setInterval(function() {
		var now = Date.now();
		if ( now - lastHeartbeat >= HEARTBEAT_MS ) {
			lastHeartbeat = now;
			console.log( "HEARTBEAT: no test completed in " + Math.round( ( now - lastProgress ) / 1000 ) +
				"s; running: " + ( currentTest || "(none / between tests)" ) );
		}
	}, 5000 );

	console.log( "URL: " + targetUrl );
	if ( skipList.length ) {
		console.log( "SEAL_SKIP_TESTS: " + skipList.length + " test(s)" );
		skipList.forEach(function( n ) {
			console.log( "  exclude: " + n + " -- reason: " + skipReasons[ n ] );
		});
	}

	puppeteer.launch({
		executablePath: process.env.CHROME_PATH,
		headless: true,
		args: [ "--no-sandbox", "--headless=new", "--disable-gpu", "--force-device-scale-factor=1" ]
	}).then(function( b ) {
		browser = b;
		browser.on( "disconnected", function() {
			finish( 2, "ERROR: browser disconnected before QUnit done" );
		});
		return browser.newPage();
	}).then(function( p ) {
		page = p;
		page.on( "console", function( msg ) {
			var ev,
				text = msg.text();
			if ( text.indexOf( PREFIX ) !== 0 ) {
				return;
			}
			try {
				ev = JSON.parse( text.slice( PREFIX.length ) );
			} catch ( e ) {
				console.log( "unparseable reporter line: " + text.slice( 0, 500 ) );
				return;
			}
			onEvent( ev );
		});
		page.on( "pageerror", function( err ) {
			console.log( "PAGE ERROR: " + ( err && err.message ? err.message : String( err ) ) );
		});
		page.on( "dialog", function( dialog ) {
			console.log( "DIALOG (" + dialog.type() + "): " + dialog.message() );
			dialog.dismiss()[ "catch" ](function() {});
		});
		page.on( "error", function( err ) {
			finish( 2, "ERROR: page crashed: " + ( err && err.message ? err.message : String( err ) ) );
		});
		return page.evaluateOnNewDocument( pageHook, skipList );
	}).then(function() {
		return page[ "goto" ]( targetUrl, { waitUntil: "load", timeout: 120000 } );
	}).then(function() {
		console.log( "page loaded; waiting for QUnit done" );
	})[ "catch" ](function( err ) {
		finish( 2, "ERROR: " + ( err && err.stack ? err.stack : String( err ) ) );
	});
}

main();

})();
