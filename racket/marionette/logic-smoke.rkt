#lang racket/base

(require (prefix-in datalog: datalog)
         (prefix-in racklog: racklog))

(provide datalog-available?
         racklog-available?)

;; This module only proves that both candidate logic libraries load into the
;; executable. Choosing which relations belong in either library remains part
;; of the human-owned workbook.
(define (datalog-available?)
  (procedure? datalog:make-theory))

(define (racklog-available?)
  (procedure? racklog:%more))
