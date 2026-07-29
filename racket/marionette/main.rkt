#lang racket/base

(require racket/cmdline
         "logic-smoke.rkt")

(provide main seed-version)

(define seed-version "0.0.0-bootstrap")

(define (main)
  (define show-version? #f)
  (command-line
   #:program "marionette"
   #:once-each
   [("-V" "--version")
    "Show the bootstrap version and loaded logic backends"
    (set! show-version? #t)]
   #:args ()
   (cond
     [show-version?
      (printf "marionette ~a (Racket seed; datalog=~a racklog=~a)\n"
              seed-version
              (if (datalog-available?) "yes" "no")
              (if (racklog-available?) "yes" "no"))]
     [else
      (displayln
       "Marionette's Racket implementation is behind the human gate; try --version.")]))
  (void))

(module+ main
  (main))
