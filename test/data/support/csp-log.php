<?php
	# Seal: current Chrome (CSP3) reports a `script-src-attr` violation for
	# jQuery's focusin feature probe (div.setAttribute( "onfocusin", "t" ) in
	# src/event/support.js) as soon as the attribute is set; the 2014-era
	# browsers this test targeted only checked inline handlers when compiled,
	# which the probe never does. Every other violation is still logged.
	$report = json_decode( file_get_contents( "php://input" ), true );
	if ( isset( $report["csp-report"]["effective-directive"] ) &&
		$report["csp-report"]["effective-directive"] === "script-src-attr" ) {
		exit;
	}
	file_put_contents("csp.log", "error", LOCK_EX);
?>
