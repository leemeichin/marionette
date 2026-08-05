#lang racket/base

(require rackunit
         racket/port
         (prefix-in cli: "../marionette/main.rkt")
         "../marionette/logic-smoke.rkt")

(test-case "both candidate logic libraries load"
  (check-true (datalog-available?))
  (check-true (racklog-available?)))

(test-case "the seed identifies itself without starting an interpreter"
  (define output
    (parameterize ([current-command-line-arguments #("--version")])
      (with-output-to-string cli:main)))
  (check-regexp-match #rx"^marionette 0\\.0\\.0-bootstrap" output)
  (check-regexp-match #rx"datalog=yes racklog=yes" output))
